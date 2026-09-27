import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { CanvasEdge, CanvasWorkspace } from "../shared/canvas";
import { ACTION_ICON, ACTION_TONE, STATE_LABEL, shortName, stateColor, toneColor, withAlpha } from "./format";
import { type Connector, layoutGraph, NODE_H, NODE_W, type PlacedEdge } from "./graph-layout";

const ARROW_LEN = 10;
const ARROW_HALF = 6;

interface MapProps {
  theme: PluginTheme;
  compact: boolean;
  workspaces: CanvasWorkspace[];
  edges: CanvasEdge[];
  onOpen(ws: CanvasWorkspace): void;
}

export function CanvasMap({ theme, compact, workspaces, edges, onOpen }: MapProps) {
  const layout = useMemo(() => layoutGraph(workspaces, edges), [workspaces, edges]);
  const byId = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
  // Keyed rather than held by reference: every refresh delivers new edge objects.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = edges.find((edge) => edgeId(edge) === selectedKey) ?? null;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);

  const childCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of workspaces) if (ws.parent) counts.set(ws.parent.id, (counts.get(ws.parent.id) ?? 0) + 1);
    return counts;
  }, [workspaces]);

  const selectedFrom = selected ? byId.get(selected.from) : undefined;
  const selectedTo = selected ? byId.get(selected.to) : undefined;

  return (
    <View style={styles.root}>
      <Legend theme={theme} />
      {selected && selectedFrom && selectedTo ? (
        <View style={styles.detail}>
          <View style={styles.detailHeader}>
            <Text style={styles.detailTitle}>
              Merge {shortName(selectedFrom)} before {shortName(selectedTo)}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close details" onPress={() => setSelectedKey(null)}>
              <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          <Text style={styles.detailBody}>
            {edgeExplanation(selected, shortName(selectedFrom), shortName(selectedTo))}
          </Text>
          {selected.files.map((file) => (
            <Text key={file} style={styles.detailFile} numberOfLines={1}>
              {file}
            </Text>
          ))}
          {selected.fileCount > selected.files.length ? (
            <Text style={styles.detailBody}>…and {selected.fileCount - selected.files.length} more</Text>
          ) : null}
        </View>
      ) : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <ScrollView horizontal contentContainerStyle={styles.scrollContent}>
          <View style={{ width: layout.width, height: layout.height }}>
            {layout.lanes.map((lane) => (
              <View
                key={lane.project}
                style={[styles.lane, { top: lane.y, height: lane.height, width: layout.width }]}
              >
                <Text style={styles.laneTitle} numberOfLines={1}>
                  {lane.project}
                </Text>
              </View>
            ))}
            {layout.families.map((family) => {
              const root = byId.get(family.rootId);
              return (
                <View
                  key={family.rootId}
                  style={[
                    styles.family,
                    { left: family.x, top: family.y, width: family.width, height: family.height },
                  ]}
                >
                  <Icon name="Network" size={13} color={theme.colors.accent} />
                  <Text style={styles.familyTitle} numberOfLines={1}>
                    {root ? shortName(root) : "Family"} and {family.size - 1} child
                    {family.size - 1 === 1 ? "" : "ren"}
                  </Text>
                </View>
              );
            })}
            {layout.connectors.map((connector, index) => (
              <ConnectorSegment key={index} connector={connector} theme={theme} />
            ))}
            {layout.edges.map((placed) => (
              <EdgeLine key={`${placed.edge.from}-${placed.edge.to}`} placed={placed} theme={theme} active={selectedKey === edgeId(placed.edge)} />
            ))}
            {layout.nodes.map(({ ws, x, y }) => (
              <Node
                key={ws.id}
                ws={ws}
                x={x}
                y={y}
                parent={ws.parent ? byId.get(ws.parent.id) : undefined}
                children={childCount.get(ws.id) ?? 0}
                theme={theme}
                styles={styles}
                onOpen={onOpen}
              />
            ))}
            {layout.edges.map((placed) => (
              <EdgeLabel
                key={`${placed.edge.from}-${placed.edge.to}-label`}
                placed={placed}
                theme={theme}
                active={selectedKey === edgeId(placed.edge)}
                onPress={() => setSelectedKey(edgeId(placed.edge))}
              />
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function Node({
  ws,
  x,
  y,
  parent,
  children,
  theme,
  styles,
  onOpen,
}: {
  ws: CanvasWorkspace;
  x: number;
  y: number;
  parent: CanvasWorkspace | undefined;
  children: number;
  theme: PluginTheme;
  styles: ReturnType<typeof makeStyles>;
  onOpen(ws: CanvasWorkspace): void;
}) {
  const tone = toneColor(theme, ACTION_TONE[ws.priority.action]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ws.name}. ${ws.priority.label}. Open workspace`}
      onPress={() => onOpen(ws)}
      style={({ pressed }) => [
        styles.node,
        { left: x, top: y, borderLeftColor: tone, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      {parent && ws.parent ? (
        <View style={styles.nodeTag}>
          <Icon name="CornerDownRight" size={12} color={theme.colors.accent} />
          <Text style={styles.nodeTagText} numberOfLines={1}>
            {ws.parent.via === "spawned" ? "spawned by" : "stacked on"} {shortName(parent)}
            {parent.project !== ws.project ? ` · ${ws.project}` : ""}
          </Text>
        </View>
      ) : null}
      <View style={styles.nodeHeader}>
        <View style={[styles.rank, { borderColor: tone }]}>
          <Text style={[styles.rankText, { color: tone }]}>{ws.priority.rank}</Text>
        </View>
        <Text style={styles.nodeTitle} numberOfLines={1}>
          {shortName(ws)}
        </Text>
        {children > 0 ? (
          <View style={styles.kids} accessibilityLabel={`${children} child workspaces`}>
            <Icon name="Network" size={11} color={theme.colors.accent} />
            <Text style={styles.kidsText}>{children}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.nodeName} numberOfLines={ws.issueKey || parent ? 1 : 2}>
        {ws.issueKey ? ws.name.replace(ws.issueKey, "").replace(/^[\s:·-]+/, "") : ws.branch ?? ""}
      </Text>
      <View style={styles.nodeFooter}>
        <View style={[styles.dot, { backgroundColor: stateColor(theme, ws.state) }]} />
        <Text style={styles.nodeState}>{STATE_LABEL[ws.state]}</Text>
        <Icon name={ACTION_ICON[ws.priority.action]} size={12} color={tone} />
        <Text style={[styles.nodeAction, { color: tone }]} numberOfLines={1}>
          {ws.priority.label}
        </Text>
      </View>
    </Pressable>
  );
}

function ConnectorSegment({ connector, theme }: { connector: Connector; theme: PluginTheme }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: connector.x,
        top: connector.y,
        width: connector.width,
        height: connector.height,
        borderRadius: 1,
        backgroundColor: connector.via === "stacked" ? theme.colors.accent : theme.colors.foregroundMuted,
      }}
    />
  );
}

function edgeId(edge: CanvasEdge): string {
  return `${edge.from}>${edge.to}`;
}

function edgeGeometry({ x1, y1, x2, y2 }: PlacedEdge) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Stop the line at the arrow's base so the tip lands exactly on the target.
  const lx2 = x2 - ARROW_LEN * cos;
  const ly2 = y2 - ARROW_LEN * sin;
  return {
    angle,
    cos,
    sin,
    length: Math.hypot(lx2 - x1, ly2 - y1),
    midX: (x1 + lx2) / 2,
    midY: (y1 + ly2) / 2,
  };
}

function EdgeLine({ placed, theme, active }: { placed: PlacedEdge; theme: PluginTheme; active: boolean }) {
  const { x2, y2, edge } = placed;
  const color = edgeColor(theme, edge.kind);
  const { angle, cos, sin, length, midX, midY } = edgeGeometry(placed);
  const thickness = active ? 3 : 2;
  return (
    <>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: midX - length / 2,
          top: midY - thickness / 2,
          width: length,
          height: 0,
          borderTopWidth: thickness,
          borderTopColor: color,
          borderStyle: edge.kind === "overlap" ? "dashed" : "solid",
          transform: [{ rotate: `${angle}rad` }],
        }}
      />
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: x2 - (ARROW_LEN / 2) * cos - ARROW_LEN / 2,
          top: y2 - (ARROW_LEN / 2) * sin - ARROW_HALF,
          width: 0,
          height: 0,
          borderTopWidth: ARROW_HALF,
          borderBottomWidth: ARROW_HALF,
          borderLeftWidth: ARROW_LEN,
          borderTopColor: "transparent",
          borderBottomColor: "transparent",
          borderLeftColor: color,
          transform: [{ rotate: `${angle}rad` }],
        }}
      />
    </>
  );
}

function EdgeLabel({
  placed,
  theme,
  active,
  onPress,
}: {
  placed: PlacedEdge;
  theme: PluginTheme;
  active: boolean;
  onPress(): void;
}) {
  const { edge } = placed;
  const color = edgeColor(theme, edge.kind);
  const { midX, midY } = edgeGeometry(placed);
  const label =
    edge.kind === "stack"
      ? "stacked"
      : `${edge.fileCount} ${edge.kind === "conflict" ? "conflict" : "file"}${edge.fileCount === 1 ? "" : "s"}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Why ${label}`}
      onPress={onPress}
      hitSlop={8}
      style={{
        position: "absolute",
        left: midX - 38,
        top: midY - 10,
        width: 76,
        height: 20,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: active ? theme.colors.surface2 : theme.colors.surface0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color, fontSize: 10, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function edgeColor(theme: PluginTheme, kind: CanvasEdge["kind"]): string {
  switch (kind) {
    case "stack":
      return theme.colors.accent;
    case "conflict":
      return theme.colors.statusDanger;
    case "overlap":
      return theme.colors.statusWarning;
  }
}

function edgeExplanation(edge: CanvasEdge, first: string, second: string): string {
  const files = `${edge.fileCount} file${edge.fileCount === 1 ? "" : "s"}`;
  switch (edge.kind) {
    case "stack":
      return `${second} is built on top of ${first}'s branch, so ${first} has to land first.`;
    case "conflict":
      return `Merging both conflicts in ${files}. ${first} is closer to landing; merge it, then rebase ${second} and resolve once.`;
    case "overlap":
      return `Both change ${files} but merge cleanly today. ${first} is closer to landing; landing it first keeps ${second}'s rebase small.`;
  }
}

function Legend({ theme }: { theme: PluginTheme }) {
  const muted = theme.colors.foregroundMuted;
  const item = { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, paddingVertical: 8 }}>
      <View style={item}>
        <View style={{ width: 14, height: 12, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: muted }} />
        <Text style={{ color: muted, fontSize: 12 }}>parent → child (boxed family)</Text>
      </View>
      <View style={item}>
        <View style={{ width: 24, borderTopWidth: 2, borderTopColor: theme.colors.accent }} />
        <Text style={{ color: muted, fontSize: 12 }}>stacked branch</Text>
      </View>
      <View style={item}>
        <View style={{ width: 24, borderTopWidth: 2, borderTopColor: theme.colors.statusDanger }} />
        <Text style={{ color: muted, fontSize: 12 }}>would conflict</Text>
      </View>
      <View style={item}>
        <View
          style={{ width: 24, borderTopWidth: 2, borderTopColor: theme.colors.statusWarning, borderStyle: "dashed" }}
        />
        <Text style={{ color: muted, fontSize: 12 }}>same files, merges cleanly</Text>
      </View>
      <Text style={{ color: muted, fontSize: 12 }}>Arrows: merge first → merge after. Tap a label for why.</Text>
    </View>
  );
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  return {
    root: { flex: 1, gap: 8 },
    scroll: { flex: 1 },
    scrollContent: { paddingBottom: compact ? 16 : 24 },
    lane: {
      position: "absolute" as const,
      left: 0,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: withAlpha(theme.colors.surface1, 0.5),
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    family: {
      position: "absolute" as const,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: withAlpha(theme.colors.accent, 0.55),
      backgroundColor: withAlpha(theme.colors.accent, 0.06, theme.colors.surface2),
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 6,
      paddingHorizontal: 12,
      paddingTop: 6,
    },
    familyTitle: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
    nodeTag: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    nodeTagText: { flex: 1, color: theme.colors.accent, fontSize: 11, fontWeight: "600" as const },
    kids: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 3,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.accent,
    },
    kidsText: { color: theme.colors.accent, fontSize: 11, fontWeight: "700" as const },
    laneTitle: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    node: {
      position: "absolute" as const,
      width: NODE_W,
      height: NODE_H,
      borderRadius: 10,
      borderWidth: 1,
      borderLeftWidth: 4,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      paddingHorizontal: 10,
      paddingVertical: 8,
      justifyContent: "space-between" as const,
    },
    nodeHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    rank: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: 4,
    },
    rankText: { fontSize: 11, fontWeight: "700" as const, fontVariant: ["tabular-nums" as const] },
    nodeTitle: { flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
    nodeName: { color: theme.colors.foregroundMuted, fontSize: 12 },
    nodeFooter: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    nodeState: { color: theme.colors.foregroundMuted, fontSize: 11, marginRight: 4 },
    nodeAction: { flex: 1, fontSize: 11, fontWeight: "600" as const },
    detail: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      padding: 12,
      gap: 4,
    },
    detailHeader: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
    detailTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flex: 1 },
    detailBody: { color: theme.colors.foregroundMuted, fontSize: 12 },
    detailFile: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" },
  };
}
