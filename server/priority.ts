import type { ActionKind, CanvasWorkspace } from "../shared/canvas";

type Unranked = Omit<CanvasWorkspace, "priority">;

export interface Verdict {
  action: ActionKind;
  score: number;
  label: string;
  reason: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Decides what the user should do next with one workspace, ignoring its neighbours. */
export function judge(ws: Unranked): Verdict {
  const { pr, agents } = ws;

  if (agents.pendingPermissions > 0 || ws.state === "needs_input") {
    const count = agents.pendingPermissions;
    return {
      action: "answer",
      score: 100,
      label: "Answer the agent",
      reason: count > 1 ? `${count} permission requests waiting` : "Agent is waiting for your input",
    };
  }
  if (ws.state === "failed" || agents.attentionReason === "error") {
    return {
      action: "fix-agent",
      score: 90,
      label: "Agent failed",
      reason: agents.lastError ? truncate(agents.lastError, 120) : "The last turn ended with an error",
    };
  }
  if (ws.state === "running") {
    return { action: "wait", score: 10, label: "Agent working", reason: "Nothing to do until it finishes" };
  }

  if (pr?.isMerged) {
    return { action: "clean-up", score: 8, label: "Archive", reason: `PR #${pr.number} is merged` };
  }
  if (pr && pr.state === "open") {
    const base = pr.baseRef ?? "base";
    if (pr.mergeable === "CONFLICTING") {
      return {
        action: "resolve-conflicts",
        score: 66,
        label: "Resolve conflicts",
        reason: ws.baseConflicts.length
          ? `PR #${pr.number} conflicts with ${base} in ${ws.baseConflicts.join(", ")}`
          : `PR #${pr.number} conflicts with ${base}`,
      };
    }
    if (pr.checks === "failure") {
      return { action: "fix-ci", score: 70, label: "Fix CI", reason: `Checks are failing on PR #${pr.number}` };
    }
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      return {
        action: "fix-review",
        score: 68,
        label: "Address review",
        reason: `Changes requested on PR #${pr.number}`,
      };
    }
    if (pr.checks === "pending") {
      return { action: "wait", score: 15, label: "CI running", reason: `Checks still running on PR #${pr.number}` };
    }
    if (pr.isDraft) {
      return {
        action: "mark-ready",
        score: 45,
        label: "Mark ready",
        reason: `PR #${pr.number} is a draft with green checks`,
      };
    }
    if (pr.reviewDecision === "REVIEW_REQUIRED") {
      return {
        action: "awaiting-review",
        score: 30,
        label: "Awaiting review",
        reason: `PR #${pr.number} needs an approval`,
      };
    }
    const known = pr.mergeable === "MERGEABLE";
    return {
      action: "merge",
      score: known ? 80 : 75,
      label: "Merge",
      reason: known
        ? `PR #${pr.number} is green and mergeable`
        : `PR #${pr.number} is green; GitHub has not computed mergeability yet`,
    };
  }

  if (ws.state === "attention") {
    return { action: "review", score: 50, label: "Review output", reason: "Agent finished; you have not looked yet" };
  }
  if (ws.changedFiles > 0 || (ws.ahead ?? 0) > 0) {
    const what = ws.dirty ? "Uncommitted changes" : "Committed changes";
    const conflicts = ws.baseConflicts.length
      ? ` · conflicts with ${ws.baseBranch ?? "base"} in ${ws.baseConflicts.length} file${ws.baseConflicts.length === 1 ? "" : "s"}`
      : "";
    return { action: "open-pr", score: 40, label: "Open a PR", reason: `${what} and no pull request${conflicts}` };
  }
  return { action: "clean-up", score: 5, label: "Archive", reason: "No changes and nothing pending" };
}

/** Actions that mean the workspace is effectively parked; blocking others does not make them urgent. */
const PASSIVE: ReadonlySet<ActionKind> = new Set(["wait", "clean-up"]);

/**
 * How close a workspace is to landing. Used to orient overlap edges so the
 * one nearer to merge goes first and the other rebases on top of it.
 */
export function readiness(ws: Unranked, verdict: Verdict): number {
  switch (verdict.action) {
    case "merge":
      return 6;
    case "awaiting-review":
    case "mark-ready":
      return 5;
    case "fix-review":
    case "fix-ci":
    case "resolve-conflicts":
      return 4;
    case "open-pr":
    case "review":
      return 3;
    case "wait":
      return ws.pr ? 4 : 1;
    default:
      return 2;
  }
}

export function withBlockerBonus(verdict: Verdict, blocks: number): Verdict {
  if (blocks === 0 || PASSIVE.has(verdict.action)) return verdict;
  return {
    ...verdict,
    score: verdict.score + blocks * 4,
    reason: `${verdict.reason} · unblocks ${blocks}`,
  };
}
