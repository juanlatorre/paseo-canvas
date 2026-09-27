import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { CanvasEdge, CanvasWorkspace } from "../shared/canvas";
import { ACTION_ICON, ACTION_TONE, STATE_LABEL, ago, needsYou, shortName, stateColor, toneColor, withAlpha } from "./format";

interface QueueProps {
  theme: PluginTheme;
  compact: boolean;
  workspaces: CanvasWorkspace[];
  edges: CanvasEdge[];
  onOpen(ws: CanvasWorkspace): void;
}

export function CanvasQueue({ theme, compact, workspaces, edges, onOpen }: QueueProps) {
  const [showParked, setShowParked] = useState(false);
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const byId = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
  const now = Date.now();

  const active = workspaces.filter(needsYou);
  const parked = workspaces.filter((ws) => !needsYou(ws));

  function relations(ws: CanvasWorkspace) {
    const before = edges.filter((edge) => edge.to === ws.id).map((edge) => byId.get(edge.from));
    const after = edges.filter((edge) => edge.from === ws.id).map((edge) => byId.get(edge.to));
    return {
      before: before.filter((x): x is CanvasWorkspace => Boolean(x)),
      after: after.filter((x): x is CanvasWorkspace => Boolean(x)),
      parent: ws.parent ? byId.get(ws.parent.id) : undefined,
      children: workspaces.filter((other) => other.parent?.id === ws.id),
    };
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
      {active.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="PartyPopper" size={28} color={theme.colors.statusSuccess} />
          <Text style={styles.emptyTitle}>Nothing needs you right now</Text>
          <Text style={styles.muted}>Agents are working or everything is parked.</Text>
        </View>
      ) : (
        active.map((ws) => (
          <Card key={ws.id} ws={ws} {...relations(ws)} now={now} theme={theme} styles={styles} onOpen={onOpen} />
        ))
      )}

      {parked.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showParked ? "Hide parked workspaces" : "Show parked workspaces"}
          onPress={() => setShowParked((value) => !value)}
          style={styles.parkedToggle}
        >
          <Icon name={showParked ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
          <Text style={styles.parkedLabel}>
            Parked · {parked.length} (running, waiting on CI or review, or nothing to do)
          </Text>
        </Pressable>
      ) : null}
      {showParked
        ? parked.map((ws) => (
            <Card key={ws.id} ws={ws} {...relations(ws)} now={now} theme={theme} styles={styles} onOpen={onOpen} />
          ))
        : null}
    </ScrollView>
  );
}

function Card({
  ws,
  before,
  after,
  parent,
  children,
  now,
  theme,
  styles,
  onOpen,
}: {
  ws: CanvasWorkspace;
  before: CanvasWorkspace[];
  after: CanvasWorkspace[];
  parent: CanvasWorkspace | undefined;
  children: CanvasWorkspace[];
  now: number;
  theme: PluginTheme;
  styles: ReturnType<typeof makeStyles>;
  onOpen(ws: CanvasWorkspace): void;
}) {
  const tone = toneColor(theme, ACTION_TONE[ws.priority.action]);
  const since = ago(ws.stateSince, now);
  const meta = [
    ws.project,
    ws.branch,
    ws.diff ? `+${ws.diff.additions} −${ws.diff.deletions}` : null,
    ws.behind ? `${ws.behind} behind ${ws.baseBranch ?? "base"}` : null,
  ].filter(Boolean);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Rank ${ws.priority.rank}: ${ws.name}. ${ws.priority.label}. Open workspace`}
      onPress={() => onOpen(ws)}
      style={({ pressed }) => [styles.card, { borderLeftColor: tone, opacity: pressed ? 0.75 : 1 }]}
    >
      <View style={styles.row}>
        <View style={[styles.rank, { borderColor: tone }]}>
          <Text style={[styles.rankText, { color: tone }]}>{ws.priority.rank}</Text>
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {ws.name}
        </Text>
        <View style={styles.statePill}>
          <View style={[styles.dot, { backgroundColor: stateColor(theme, ws.state) }]} />
          <Text style={styles.stateText}>
            {STATE_LABEL[ws.state]}
            {since ? ` · ${since}` : ""}
          </Text>
        </View>
      </View>

      <View style={styles.actionRow}>
        <Icon name={ACTION_ICON[ws.priority.action]} size={15} color={tone} />
        <Text style={[styles.action, { color: tone }]}>{ws.priority.label}</Text>
        <Text style={styles.reason} numberOfLines={2}>
          {ws.priority.reason}
        </Text>
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        {meta.join("  ·  ")}
      </Text>

      {ws.pr || before.length || after.length || parent || children.length ? (
        <View style={styles.chips}>
          {parent && ws.parent ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open parent workspace ${parent.name}`}
              onPress={() => onOpen(parent)}
              hitSlop={6}
              style={[styles.chip, { borderColor: theme.colors.accent }]}
            >
              <Icon name="CornerDownRight" size={12} color={theme.colors.accent} />
              <Text style={[styles.chipText, { color: theme.colors.accent }]}>
                {ws.parent.via === "spawned" ? "spawned by" : "stacked on"} {shortName(parent)}
              </Text>
            </Pressable>
          ) : null}
          {children.length ? (
            <View style={[styles.chip, { borderColor: theme.colors.accent }]}>
              <Icon name="Network" size={12} color={theme.colors.accent} />
              <Text style={[styles.chipText, { color: theme.colors.accent }]}>
                {children.length} child{children.length === 1 ? "" : "ren"}: {children.map(shortName).join(", ")}
              </Text>
            </View>
          ) : null}
          {ws.pr ? <PrChip ws={ws} theme={theme} styles={styles} /> : null}
          {before.length ? (
            <View style={styles.chip}>
              <Icon name="ArrowLeftToLine" size={12} color={theme.colors.foregroundMuted} />
              <Text style={styles.chipText}>after {before.map(shortName).join(", ")}</Text>
            </View>
          ) : null}
          {after.length ? (
            <View style={[styles.chip, { borderColor: withAlpha(tone, 0.6) }]}>
              <Icon name="ArrowRightFromLine" size={12} color={tone} />
              <Text style={[styles.chipText, { color: tone }]}>before {after.map(shortName).join(", ")}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function PrChip({
  ws,
  theme,
  styles,
}: {
  ws: CanvasWorkspace;
  theme: PluginTheme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const pr = ws.pr!;
  const checkIcon =
    pr.checks === "success"
      ? { name: "CircleCheck", color: theme.colors.statusSuccess }
      : pr.checks === "failure"
        ? { name: "CircleX", color: theme.colors.statusDanger }
        : pr.checks === "pending"
          ? { name: "CircleDashed", color: theme.colors.statusWarning }
          : null;
  const flags = [
    pr.isMerged ? "merged" : null,
    pr.isDraft ? "draft" : null,
    pr.mergeable === "CONFLICTING" ? "conflicts" : null,
    pr.reviewDecision === "APPROVED" ? "approved" : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open pull request ${pr.number} on GitHub`}
      onPress={() => void openExternalUrl(pr.url)}
      hitSlop={6}
      style={styles.chip}
    >
      <Icon name={pr.isMerged ? "GitMerge" : "GitPullRequest"} size={12} color={theme.colors.foreground} />
      <Text style={[styles.chipText, { color: theme.colors.foreground }]}>#{pr.number}</Text>
      {checkIcon ? <Icon name={checkIcon.name} size={12} color={checkIcon.color} /> : null}
      {flags.length ? <Text style={styles.chipText}>{flags.join(" · ")}</Text> : null}
      <Icon name="ExternalLink" size={11} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  return {
    scroll: { flex: 1 },
    list: { gap: 10, paddingBottom: compact ? 16 : 24 },
    card: {
      borderRadius: 12,
      borderWidth: 1,
      borderLeftWidth: 4,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      padding: compact ? 12 : 14,
      gap: 8,
    },
    row: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10 },
    rank: {
      minWidth: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: 1.5,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: 4,
    },
    rankText: { fontSize: 12, fontWeight: "700" as const, fontVariant: ["tabular-nums" as const] },
    title: { flex: 1, color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const, lineHeight: 20 },
    statePill: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 5,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      backgroundColor: theme.colors.surface2,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    stateText: { color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums" as const] },
    actionRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    action: { fontSize: 13, fontWeight: "700" as const },
    reason: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 13 },
    meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
    chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 5,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    chipText: { color: theme.colors.foregroundMuted, fontSize: 12 },
    empty: { alignItems: "center" as const, gap: 6, paddingVertical: 32 },
    emptyTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    parkedToggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingVertical: 8 },
    parkedLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
  };
}
