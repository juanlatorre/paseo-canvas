import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CanvasSurface } from "./client/canvas-surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("canvas", CanvasSurface);
  client.addSidebarItem({
    id: "canvas",
    title: "Canvas",
    icon: "Workflow",
    surface: "canvas",
  });
  client.addCommandCenterItem({
    id: "open-canvas",
    title: "Open Canvas: workspace map and merge order",
    icon: "Workflow",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("canvas");
    },
  });
  return () => {};
}
