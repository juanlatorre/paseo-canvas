import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PullRequest, CanvasEdge, CanvasSnapshot, CanvasWorkspace } from "../shared/canvas";
import {
  changedFiles,
  commitsAhead,
  defaultBranch,
  headSha,
  isAncestor,
  mergeConflicts,
  resolveBaseRef,
} from "./git";
import { judge, readiness, withBlockerBonus, type Verdict } from "./priority";

type Paseo = PluginHandlerContext["paseo"];
type WorkspaceEntry = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];
type AgentEntry = Awaited<ReturnType<Paseo["agents"]["list"]>>["entries"][number]["agent"];
type Unranked = Omit<CanvasWorkspace, "priority">;

const PAGE_LIMIT = 200;
const MAX_EDGE_FILES = 8;

async function listWorkspaces(paseo: Paseo): Promise<WorkspaceEntry[]> {
  const all: WorkspaceEntry[] = [];
  let cursor: string | undefined;
  do {
    const result = await paseo.workspaces.list({ page: { limit: PAGE_LIMIT, cursor } });
    all.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return all.filter((ws) => !ws.archivingAt);
}

/** Includes archived agents: a parent agent is often archived while the workspace it spawned lives on. */
async function listAgents(paseo: Paseo): Promise<AgentEntry[]> {
  const all: AgentEntry[] = [];
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: PAGE_LIMIT, cursor },
    });
    all.push(...result.entries.map((entry) => entry.agent));
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

/** Set by Paseo on agents created by another agent, e.g. through the Paseo MCP `create_agent` tool. */
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/**
 * Maps a workspace to the workspace whose agent created it. The earliest
 * cross-workspace spawn wins, since that is the agent that started the work.
 */
function spawnParents(agents: AgentEntry[]): Map<string, string> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const parents = new Map<string, { parent: string; at: string }>();
  for (const agent of agents) {
    const parentAgentId = agent.labels?.[PARENT_AGENT_LABEL];
    const parentWorkspace = parentAgentId ? byId.get(parentAgentId)?.workspaceId : undefined;
    if (!agent.workspaceId || !parentWorkspace || parentWorkspace === agent.workspaceId) continue;
    const known = parents.get(agent.workspaceId);
    if (!known || agent.createdAt < known.at) {
      parents.set(agent.workspaceId, { parent: parentWorkspace, at: agent.createdAt });
    }
  }
  return new Map([...parents].map(([child, { parent }]) => [child, parent]));
}

/** Spawn parents first, then stacked branches for workspaces that were not spawned. Never creates a cycle. */
function assignParents(items: Unranked[], spawned: Map<string, string>, edges: CanvasEdge[]): void {
  const byId = new Map(items.map((ws) => [ws.id, ws]));
  function wouldCycle(child: string, parent: string): boolean {
    for (let at: string | undefined = parent; at; at = byId.get(at)?.parent?.id) {
      if (at === child) return true;
    }
    return false;
  }
  for (const ws of items) {
    const parent = spawned.get(ws.id);
    if (parent && byId.has(parent) && !wouldCycle(ws.id, parent)) ws.parent = { id: parent, via: "spawned" };
  }
  for (const edge of edges) {
    const child = byId.get(edge.to);
    if (edge.kind !== "stack" || !child || child.parent || wouldCycle(edge.to, edge.from)) continue;
    child.parent = { id: edge.from, via: "stacked" };
  }
}

const ISSUE_IN_TEXT = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
const ISSUE_IN_BRANCH = /(?:^|[/_-])([a-z][a-z0-9]{1,9}-\d+)(?=$|[/_-])/i;

function issueKey(name: string, branch: string | null): string | null {
  const fromName = ISSUE_IN_TEXT.exec(name)?.[1];
  if (fromName) return fromName;
  const fromBranch = branch ? ISSUE_IN_BRANCH.exec(branch)?.[1] : undefined;
  return fromBranch ? fromBranch.toUpperCase() : null;
}

function toPullRequest(ws: WorkspaceEntry): PullRequest | null {
  const pr = ws.githubRuntime?.pullRequest;
  if (!pr) return null;
  const checks = pr.checksStatus;
  return {
    number: pr.number ?? 0,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft ?? false,
    isMerged: pr.isMerged ?? pr.state === "merged",
    mergeable: pr.mergeable ?? null,
    checks: checks === "success" || checks === "failure" || checks === "pending" ? checks : "none",
    reviewDecision: pr.reviewDecision ?? null,
    baseRef: pr.baseRefName ?? null,
    headRef: pr.headRefName ?? null,
  };
}

function summarizeAgents(agents: AgentEntry[]): Unranked["agents"] {
  const attention = agents.find((agent) => agent.requiresAttention);
  const newest = [...agents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const errored = agents.find((agent) => agent.lastError);
  return {
    total: agents.length,
    running: agents.filter((agent) => agent.status === "running").length,
    pendingPermissions: agents.reduce((sum, agent) => sum + (agent.pendingPermissions?.length ?? 0), 0),
    attentionReason: attention?.attentionReason ?? null,
    lastError: errored?.lastError ?? null,
    primaryAgentId: (attention ?? newest)?.id ?? null,
  };
}

/** Git facts gathered per workspace so edges can be computed across a repository. */
interface GitFacts {
  repo: string;
  head: string;
  files: Set<string>;
  hasOwnCommits: boolean;
  /** `null` when git could not tell. */
  baseConflicts: string[] | null;
}

async function gatherGit(ws: WorkspaceEntry, base: string): Promise<GitFacts | null> {
  const branch = ws.gitRuntime?.currentBranch ?? null;
  if (ws.projectKind !== "git" || !branch || branch === base) return null;
  const cwd = ws.workspaceDirectory;
  const [head, baseRef] = await Promise.all([headSha(cwd), resolveBaseRef(cwd, base)]);
  if (!head || !baseRef) return null;
  const [files, ahead, baseConflicts] = await Promise.all([
    changedFiles(cwd, baseRef, head),
    commitsAhead(cwd, baseRef, head),
    mergeConflicts(cwd, baseRef, head),
  ]);
  return {
    repo: ws.project?.checkout?.mainRepoRoot ?? ws.projectRootPath,
    head,
    files: new Set(files),
    hasOwnCommits: ahead > 0,
    baseConflicts,
  };
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

/** Drops `a → c` when `a → b → c` already says the same thing. */
function reduceTransitively(edges: CanvasEdge[]): CanvasEdge[] {
  const out = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!out.has(edge.from)) out.set(edge.from, new Set());
    out.get(edge.from)!.add(edge.to);
  }
  function reachableWithoutDirect(from: string, to: string): boolean {
    const stack = [...(out.get(from) ?? [])].filter((next) => next !== to);
    const seen = new Set<string>(stack);
    while (stack.length) {
      const node = stack.pop()!;
      if (node === to) return true;
      for (const next of out.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }
  return edges.filter((edge) => !reachableWithoutDirect(edge.from, edge.to));
}

async function computeEdges(
  items: Unranked[],
  facts: Map<string, GitFacts>,
  verdicts: Map<string, Verdict>,
): Promise<CanvasEdge[]> {
  const byBranch = new Map<string, Unranked>();
  for (const ws of items) if (ws.branch && facts.has(ws.id)) byBranch.set(`${facts.get(ws.id)!.repo}\0${ws.branch}`, ws);

  const stack: CanvasEdge[] = [];
  const stacked = new Set<string>();
  function addStack(from: Unranked, to: Unranked) {
    const key = edgeKey(from.id, to.id);
    if (stacked.has(key)) return;
    stacked.add(key);
    stack.push({ from: from.id, to: to.id, kind: "stack", files: [], fileCount: 0 });
  }

  // A PR opened against another workspace's branch is an explicit stack.
  for (const ws of items) {
    const repo = facts.get(ws.id)?.repo;
    const parent = repo && ws.pr?.baseRef ? byBranch.get(`${repo}\0${ws.pr.baseRef}`) : undefined;
    if (parent && parent.id !== ws.id) addStack(parent, ws);
  }

  const withGit = items.filter((ws) => facts.has(ws.id));
  const pairs: Array<[Unranked, Unranked]> = [];
  for (let i = 0; i < withGit.length; i++) {
    for (let j = i + 1; j < withGit.length; j++) {
      if (facts.get(withGit[i].id)!.repo === facts.get(withGit[j].id)!.repo) pairs.push([withGit[i], withGit[j]]);
    }
  }

  // A branch whose commits already contain another workspace's commits is an implicit stack.
  await Promise.all(
    pairs.map(async ([a, b]) => {
      const fa = facts.get(a.id)!;
      const fb = facts.get(b.id)!;
      if (fa.head === fb.head) return;
      if (fb.hasOwnCommits && (await isAncestor(fa.repo, fb.head, fa.head))) addStack(b, a);
      else if (fa.hasOwnCommits && (await isAncestor(fa.repo, fa.head, fb.head))) addStack(a, b);
    }),
  );

  const overlap = await Promise.all(
    pairs.map(async ([a, b]): Promise<CanvasEdge | null> => {
      if (stacked.has(edgeKey(a.id, b.id))) return null;
      const fa = facts.get(a.id)!;
      const fb = facts.get(b.id)!;
      const shared = [...fa.files].filter((file) => fb.files.has(file)).sort();
      if (shared.length === 0) return null;
      const conflicts = (await mergeConflicts(fa.repo, fa.head, fb.head)) ?? [];
      const files = conflicts.length > 0 ? conflicts : shared;
      const [first, second] = orderForMerge(a, b, verdicts);
      return {
        from: first.id,
        to: second.id,
        kind: conflicts.length > 0 ? "conflict" : "overlap",
        files: files.slice(0, MAX_EDGE_FILES),
        fileCount: files.length,
      };
    }),
  );

  return [...reduceTransitively(stack), ...overlap.filter((edge): edge is CanvasEdge => edge !== null)];
}

function diffSize(ws: Unranked): number {
  return (ws.diff?.additions ?? 0) + (ws.diff?.deletions ?? 0);
}

/** Closer to landing goes first; on a tie the smaller change lands first and the bigger one rebases. */
function orderForMerge(a: Unranked, b: Unranked, verdicts: Map<string, Verdict>): [Unranked, Unranked] {
  const ra = readiness(a, verdicts.get(a.id)!);
  const rb = readiness(b, verdicts.get(b.id)!);
  if (ra !== rb) return ra > rb ? [a, b] : [b, a];
  const sa = diffSize(a);
  const sb = diffSize(b);
  if (sa !== sb) return sa < sb ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

export async function buildSnapshot(paseo: Paseo): Promise<CanvasSnapshot> {
  const warnings: string[] = [];
  const [workspaces, agents] = await Promise.all([listWorkspaces(paseo), listAgents(paseo)]);

  const agentsByWorkspace = new Map<string, AgentEntry[]>();
  for (const agent of agents) {
    if (!agent.workspaceId || agent.archivedAt) continue;
    if (!agentsByWorkspace.has(agent.workspaceId)) agentsByWorkspace.set(agent.workspaceId, []);
    agentsByWorkspace.get(agent.workspaceId)!.push(agent);
  }

  const facts = new Map<string, GitFacts>();
  const items: Unranked[] = await Promise.all(
    workspaces.map(async (ws): Promise<Unranked> => {
      const branch = ws.gitRuntime?.currentBranch ?? null;
      let pr = toPullRequest(ws);
      let base: string | null = null;
      if (ws.projectKind === "git") {
        const repo = ws.project?.checkout?.mainRepoRoot ?? ws.projectRootPath;
        base = pr?.baseRef ?? (await defaultBranch(repo));
        try {
          const gathered = await gatherGit(ws, base);
          if (gathered) facts.set(ws.id, gathered);
        } catch (error) {
          warnings.push(`${ws.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const baseConflicts = facts.get(ws.id)?.baseConflicts ?? null;
      // GitHub computes mergeability lazily and often reports UNKNOWN; the local merge answers immediately.
      if (pr && pr.state === "open" && (!pr.mergeable || pr.mergeable === "UNKNOWN") && baseConflicts) {
        pr = { ...pr, mergeable: baseConflicts.length > 0 ? "CONFLICTING" : "MERGEABLE" };
      }
      return {
        id: ws.id,
        name: ws.title ?? ws.name,
        project: ws.projectCustomName ?? ws.projectDisplayName,
        projectId: ws.projectId,
        directory: ws.workspaceDirectory,
        branch,
        baseBranch: base,
        state: ws.status,
        stateSince: ws.statusEnteredAt ?? null,
        issueKey: issueKey(ws.title ?? ws.name, branch),
        dirty: ws.gitRuntime?.isDirty ?? false,
        ahead: ws.gitRuntime?.aheadBehind?.ahead ?? null,
        behind: ws.gitRuntime?.aheadBehind?.behind ?? null,
        diff: ws.diffStat ?? null,
        changedFiles: facts.get(ws.id)?.files.size ?? 0,
        baseConflicts: (baseConflicts ?? []).slice(0, MAX_EDGE_FILES),
        pr,
        parent: null,
        agents: summarizeAgents(agentsByWorkspace.get(ws.id) ?? []),
      };
    }),
  );

  const verdicts = new Map(items.map((ws) => [ws.id, judge(ws)]));
  const edges = await computeEdges(items, facts, verdicts);
  assignParents(items, spawnParents(agents), edges);

  const blocks = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!blocks.has(edge.from)) blocks.set(edge.from, new Set());
    blocks.get(edge.from)!.add(edge.to);
  }

  const ranked = items
    .map((ws) => ({ ws, verdict: withBlockerBonus(verdicts.get(ws.id)!, blocks.get(ws.id)?.size ?? 0) }))
    .sort(
      (a, b) =>
        b.verdict.score - a.verdict.score ||
        (a.ws.stateSince ?? "").localeCompare(b.ws.stateSince ?? "") ||
        a.ws.name.localeCompare(b.ws.name),
    )
    .map(({ ws, verdict }, index): CanvasWorkspace => ({ ...ws, priority: { rank: index + 1, ...verdict } }));

  return { generatedAt: new Date().toISOString(), workspaces: ranked, edges, warnings };
}
