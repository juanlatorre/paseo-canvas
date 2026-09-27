import type { PluginTheme } from "@getpaseo/plugin";
import type { ActionKind, CanvasWorkspace, WorkspaceState } from "../shared/canvas";

export type Tone = "warning" | "danger" | "success" | "accent" | "muted";

export const ACTION_TONE: Record<ActionKind, Tone> = {
  answer: "warning",
  "fix-agent": "danger",
  "fix-ci": "danger",
  "fix-review": "danger",
  "resolve-conflicts": "danger",
  merge: "success",
  review: "accent",
  "mark-ready": "accent",
  "open-pr": "accent",
  "awaiting-review": "muted",
  wait: "muted",
  "clean-up": "muted",
};

export const ACTION_ICON: Record<ActionKind, string> = {
  answer: "MessageCircleQuestion",
  "fix-agent": "OctagonAlert",
  "fix-ci": "CircleX",
  "fix-review": "MessageSquareWarning",
  "resolve-conflicts": "GitMerge",
  merge: "GitMerge",
  review: "Eye",
  "mark-ready": "GitPullRequestDraft",
  "open-pr": "GitPullRequestCreate",
  "awaiting-review": "Hourglass",
  wait: "Loader",
  "clean-up": "Archive",
};

export const STATE_LABEL: Record<WorkspaceState, string> = {
  needs_input: "Needs input",
  failed: "Failed",
  attention: "Finished",
  running: "Running",
  done: "Idle",
};

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "success":
      return theme.colors.statusSuccess;
    case "accent":
      return theme.colors.accent;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}

export function stateColor(theme: PluginTheme, state: WorkspaceState): string {
  switch (state) {
    case "needs_input":
      return theme.colors.statusWarning;
    case "failed":
      return theme.colors.statusDanger;
    case "attention":
      return theme.colors.statusSuccess;
    case "running":
      return theme.colors.accent;
    case "done":
      return theme.colors.foregroundMuted;
  }
}

/** Whether the workspace is waiting on the user rather than on an agent or CI. */
export function needsYou(ws: CanvasWorkspace): boolean {
  const tone = ACTION_TONE[ws.priority.action];
  return tone !== "muted";
}

export function ago(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A short label for map nodes and edge lists: the Linear key when present, else the name. */
export function shortName(ws: CanvasWorkspace): string {
  return ws.issueKey ?? ws.name;
}

/** Adds a hex alpha channel when the token is a 6-digit hex color; otherwise returns `fallback`. */
export function withAlpha(color: string, alpha: number, fallback: string = color): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return fallback;
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${byte}`;
}
