import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { type CanvasWorkspace, canvasSnapshotRpc } from "../shared/canvas";
import { ACTION_TONE, ago, needsYou } from "./format";
import { CanvasMap } from "./map";
import { CanvasQueue } from "./queue";

const REFRESH_MS = 10_000;

type Tab = "canvas" | "queue";

export function CanvasSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const snapshot = useRpc(canvasSnapshotRpc);
  const query = useQuery({
    queryKey: ["canvas", host.id],
    queryFn: () => snapshot({}),
    refetchInterval: REFRESH_MS,
  });
  const [tab, setTab] = useState<Tab>("canvas");
  const [project, setProject] = useState<string | null>(null);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);

  const data = query.data;
  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of data?.workspaces ?? []) counts.set(ws.project, (counts.get(ws.project) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);
  const workspaces = useMemo(
    () => (data?.workspaces ?? []).filter((ws) => !project || ws.project === project),
    [data, project],
  );
  const edges = useMemo(() => {
    const ids = new Set(workspaces.map((ws) => ws.id));
    return (data?.edges ?? []).filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }, [data, workspaces]);

  function open(ws: CanvasWorkspace) {
    navigation?.openWorkspace({ workspaceId: ws.id });
  }

  if (!data) {
    return (
      <View style={[styles.screen, styles.center]}>
        {query.error ? (
          <>
            <Icon name="TriangleAlert" size={24} color={theme.colors.statusDanger} />
            <Text style={styles.errorText}>Could not load workspaces: {String(query.error)}</Text>
            <Button theme={theme} label="Retry" icon="RefreshCw" onPress={() => void query.refetch()} />
          </>
        ) : (
          <>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={styles.muted}>Scanning workspaces…</Text>
          </>
        )}
      </View>
    );
  }

  const needYou = workspaces.filter(needsYou).length;
  const toMerge = workspaces.filter((ws) => ws.priority.action === "merge").length;
  const blocked = workspaces.filter((ws) => ACTION_TONE[ws.priority.action] === "danger").length;
  const running = workspaces.filter((ws) => ws.state === "running").length;
  const top = workspaces[0];

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title}>Canvas</Text>
          <Text style={styles.muted}>
            {workspaces.length} workspaces · updated {ago(data.generatedAt, Date.now()) ?? "now"} ago
          </Text>
        </View>
        <Button
          theme={theme}
          label={query.isFetching ? "Refreshing" : "Refresh"}
          icon="RefreshCw"
          onPress={() => void query.refetch()}
        />
      </View>

      <View style={styles.stats}>
        <Stat theme={theme} value={needYou} label="need you" color={theme.colors.statusWarning} />
        <Stat theme={theme} value={toMerge} label="ready to merge" color={theme.colors.statusSuccess} />
        <Stat theme={theme} value={blocked} label="blocked" color={theme.colors.statusDanger} />
        <Stat theme={theme} value={running} label="running" color={theme.colors.accent} />
      </View>

      {top && needsYou(top) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Next up: ${top.name}. ${top.priority.label}. Open workspace`}
          onPress={() => open(top)}
          style={({ pressed }) => [styles.next, { opacity: pressed ? 0.8 : 1 }]}
        >
          <Icon name="ArrowRight" size={16} color={theme.colors.accentForeground} />
          <Text style={styles.nextText} numberOfLines={1}>
            Next: {top.priority.label} — {top.name}
          </Text>
        </Pressable>
      ) : null}

      {projects.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
          <View style={styles.filters}>
            <Chip theme={theme} label="All" active={!project} onPress={() => setProject(null)} />
            {projects.map(([name, count]) => (
              <Chip
                key={name}
                theme={theme}
                label={`${name} ${count}`}
                active={project === name}
                onPress={() => setProject(project === name ? null : name)}
              />
            ))}
          </View>
        </ScrollView>
      ) : null}

      <View style={styles.tabs}>
        <TabButton theme={theme} label="Canvas" icon="Workflow" active={tab === "canvas"} onPress={() => setTab("canvas")} />
        <TabButton theme={theme} label="Queue" icon="ListOrdered" active={tab === "queue"} onPress={() => setTab("queue")} />
      </View>

      {data.warnings.length ? (
        <Text style={styles.warning} numberOfLines={2}>
          {data.warnings.join(" · ")}
        </Text>
      ) : null}

      {tab === "queue" ? (
        <CanvasQueue theme={theme} compact={layout.compact} workspaces={workspaces} edges={edges} onOpen={open} />
      ) : (
        <CanvasMap theme={theme} compact={layout.compact} workspaces={workspaces} edges={edges} onOpen={open} />
      )}
    </View>
  );
}

function Stat({ theme, value, label, color }: { theme: PluginTheme; value: number; label: string; color: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: value ? color : theme.colors.foregroundMuted, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

function Button({ theme, label, icon, onPress }: { theme: PluginTheme; label: string; icon: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={14} color={theme.colors.foreground} />
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function Chip({ theme, label, active, onPress }: { theme: PluginTheme; label: string; active: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Filter ${label}`}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
      }}
    >
      <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function TabButton({
  theme,
  label,
  icon,
  active,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  icon: string;
  active: boolean;
  onPress(): void;
}) {
  const color = active ? theme.colors.foreground : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: active ? theme.colors.surface2 : "transparent",
      }}
    >
      <Icon name={icon} size={14} color={color} />
      <Text style={{ color, fontSize: 13, fontWeight: active ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: {
      flex: 1,
      padding: compact ? 16 : 24,
      gap: compact ? 10 : 14,
      backgroundColor: theme.colors.surface0,
    },
    center: { alignItems: "center" as const, justifyContent: "center" as const },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 22 : 26, fontWeight: "700" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    errorText: { color: theme.colors.statusDanger, fontSize: 13, textAlign: "center" as const },
    warning: { color: theme.colors.statusWarning, fontSize: 12 },
    stats: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    next: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: theme.colors.accent,
    },
    nextText: { flex: 1, color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
    filters: { flexDirection: "row" as const, gap: 6 },
    tabs: {
      flexDirection: "row" as const,
      gap: 4,
      padding: 4,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
  };
}
