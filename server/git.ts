import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Keyed by commit ids, so entries never go stale; the cap only bounds memory in a long-lived daemon. */
const CACHE_LIMIT = 2000;

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

const defaultBranchCache = new Map<string, string>();

/** `main`, `master`, or whatever `origin/HEAD` points at. */
export async function defaultBranch(repoRoot: string): Promise<string> {
  const cached = defaultBranchCache.get(repoRoot);
  if (cached) return cached;
  const head = await git(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const branch = head ? head.replace(/^origin\//, "") : "main";
  defaultBranchCache.set(repoRoot, branch);
  return branch;
}

/** Prefers the remote-tracking ref so a stale local base does not inflate the diff. */
export async function resolveBaseRef(cwd: string, base: string): Promise<string | null> {
  for (const ref of [`origin/${base}`, base]) {
    if (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  return null;
}

export function headSha(cwd: string): Promise<string | null> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

const committedFilesCache = new Map<string, string[]>();

/**
 * Files this branch changes relative to its base: committed changes since the
 * merge-base plus whatever is still uncommitted in the worktree.
 */
export async function changedFiles(cwd: string, baseRef: string, head: string): Promise<string[]> {
  const baseSha = await git(cwd, ["rev-parse", baseRef]);
  const key = `${cwd}\0${head}\0${baseSha}`;
  let committed = committedFilesCache.get(key);
  if (!committed) {
    const out = await git(cwd, ["diff", "--name-only", `${baseRef}...HEAD`]);
    committed = out ? out.split("\n").filter(Boolean) : [];
    remember(committedFilesCache, key, committed);
  }
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  const uncommitted = status
    ? status
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).split(" -> ").pop() ?? "")
    : [];
  return [...new Set([...committed, ...uncommitted])].filter(Boolean);
}

/** Number of commits on `head` that are not on `baseRef`. */
export async function commitsAhead(cwd: string, baseRef: string, head: string): Promise<number> {
  const out = await git(cwd, ["rev-list", "--count", `${baseRef}..${head}`]);
  return out ? Number(out) || 0 : 0;
}

const conflictCache = new Map<string, string[] | null>();

/**
 * Files that would conflict if `ours` and `theirs` were merged, computed in
 * memory by `git merge-tree` without touching any worktree. `null` when git
 * cannot answer (old git, missing objects).
 */
export async function mergeConflicts(cwd: string, ours: string, theirs: string): Promise<string[] | null> {
  const key = ours < theirs ? `${ours}\0${theirs}` : `${theirs}\0${ours}`;
  if (conflictCache.has(key)) return conflictCache.get(key)!;
  let result: string[] | null;
  try {
    await execFileAsync("git", ["-C", cwd, "merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs], {
      timeout: 15_000,
    });
    result = [];
  } catch (error) {
    // Exit status 1 means "conflicts"; stdout is the tree id followed by the conflicted paths.
    const failure = error as { code?: number; stdout?: string };
    result =
      failure.code === 1 && typeof failure.stdout === "string"
        ? [...new Set(failure.stdout.trim().split("\n").slice(1).filter(Boolean))]
        : null;
  }
  return remember(conflictCache, key, result);
}

const ancestorCache = new Map<string, boolean>();

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return false;
  const key = `${ancestor}\0${descendant}`;
  const cached = ancestorCache.get(key);
  if (cached !== undefined) return cached;
  let result: boolean;
  try {
    await execFileAsync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeout: 10_000,
    });
    result = true;
  } catch {
    result = false;
  }
  return remember(ancestorCache, key, result);
}
