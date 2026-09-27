import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const workspaceStateSchema = z.enum(["needs_input", "failed", "attention", "running", "done"]);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

/**
 * What the user should do next with a workspace. Ordered roughly by urgency;
 * the numeric score in `priority` decides the actual queue order.
 */
export const actionKindSchema = z.enum([
  "answer",
  "fix-agent",
  "merge",
  "fix-review",
  "fix-ci",
  "resolve-conflicts",
  "review",
  "mark-ready",
  "open-pr",
  "awaiting-review",
  "wait",
  "clean-up",
]);
export type ActionKind = z.infer<typeof actionKindSchema>;

export const pullRequestSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  isMerged: z.boolean(),
  mergeable: z.string().nullable(),
  checks: z.enum(["success", "failure", "pending", "none"]),
  reviewDecision: z.string().nullable(),
  baseRef: z.string().nullable(),
  headRef: z.string().nullable(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const canvasWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  project: z.string(),
  projectId: z.string(),
  directory: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  state: workspaceStateSchema,
  stateSince: z.string().nullable(),
  issueKey: z.string().nullable(),
  dirty: z.boolean(),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  diff: z.object({ additions: z.number(), deletions: z.number() }).nullable(),
  changedFiles: z.number(),
  /** Files that would conflict when merging into the base branch, from a local `git merge-tree`. */
  baseConflicts: z.array(z.string()),
  pr: pullRequestSchema.nullable(),
  /**
   * The workspace this one came from. `spawned`: an agent in the parent created
   * this workspace's agent. `stacked`: this branch is built on the parent's branch.
   */
  parent: z.object({ id: z.string(), via: z.enum(["spawned", "stacked"]) }).nullable(),
  agents: z.object({
    total: z.number(),
    running: z.number(),
    pendingPermissions: z.number(),
    attentionReason: z.string().nullable(),
    lastError: z.string().nullable(),
    primaryAgentId: z.string().nullable(),
  }),
  priority: z.object({
    rank: z.number(),
    score: z.number(),
    action: actionKindSchema,
    label: z.string(),
    reason: z.string(),
  }),
});
export type CanvasWorkspace = z.infer<typeof canvasWorkspaceSchema>;

/**
 * `from` should be merged before `to`.
 * - `stack`: `to` is built on top of `from`'s branch.
 * - `conflict`: merging both would conflict in `files`; `from` is the one closer to landing.
 * - `overlap`: both change the same files but merge cleanly; same orientation as `conflict`.
 */
export const canvasEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["stack", "conflict", "overlap"]),
  files: z.array(z.string()),
  fileCount: z.number(),
});
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;

export const canvasSnapshotSchema = z.object({
  generatedAt: z.string(),
  workspaces: z.array(canvasWorkspaceSchema),
  edges: z.array(canvasEdgeSchema),
  warnings: z.array(z.string()),
});
export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>;

export const canvasSnapshotRpc = defineRpc({
  name: "canvas.snapshot",
  input: z.object({}),
  output: canvasSnapshotSchema,
});
