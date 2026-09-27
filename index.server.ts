import type { PluginServerContext } from "@getpaseo/plugin/server";
import { buildSnapshot } from "./server/snapshot";
import { canvasSnapshotRpc } from "./shared/canvas";

export default function contribute(server: PluginServerContext) {
  server.handle(canvasSnapshotRpc, (_input, { paseo }) => buildSnapshot(paseo));
  return () => {};
}
