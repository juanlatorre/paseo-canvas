import type { CanvasEdge, CanvasWorkspace } from "../shared/canvas";

export const NODE_W = 232;
export const NODE_H = 112;
const GAP_X = 96;
const TREE_GAP_X = 56;
const GAP_Y = 20;
const LANE_HEADER = 32;
const LANE_PAD = 16;
const LANE_GAP = 20;
const FAMILY_PAD = 12;
const FAMILY_HEADER = 24;
const BLOCK_GAP = 24;
const MIN_LOOSE_COLUMNS = 3;

export interface PlacedNode {
  ws: CanvasWorkspace;
  x: number;
  y: number;
}

export interface PlacedEdge {
  edge: CanvasEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** An axis-aligned segment of a parent → children connector. */
export interface Connector {
  x: number;
  y: number;
  width: number;
  height: number;
  via: "spawned" | "stacked" | "spine";
}

export interface Family {
  rootId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
}

export interface Lane {
  project: string;
  y: number;
  height: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  lanes: Lane[];
  families: Family[];
  connectors: Connector[];
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

/**
 * Drops `a → c` when `a → b → c` exists. The queue still lists every relation;
 * the canvas only needs the ones that are not implied.
 */
function withoutImplied(edges: CanvasEdge[]): CanvasEdge[] {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from)!.push(edge.to);
  }
  function reachable(from: string, to: string): boolean {
    const stack = (out.get(from) ?? []).filter((next) => next !== to);
    const seen = new Set(stack);
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
  return edges.filter((edge) => !reachable(edge.from, edge.to));
}

/** Longest path from any root, so every merge arrow in a block points rightward. Cycles are cut. */
function depths(ids: string[], edges: CanvasEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to)!.push(edge.from);
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const parent of incoming.get(id) ?? []) d = Math.max(d, depth(parent) + 1);
    visiting.delete(id);
    memo.set(id, d);
    return d;
  }
  for (const id of ids) depth(id);
  return memo;
}

function byRank(a: CanvasWorkspace, b: CanvasWorkspace): number {
  return a.priority.rank - b.priority.rank;
}

/** Connects the facing sides of two nodes so arrows work in any direction. */
function attach(from: PlacedNode, to: PlacedNode): Omit<PlacedEdge, "edge"> {
  if (to.x >= from.x + NODE_W) {
    return { x1: from.x + NODE_W, y1: from.y + NODE_H / 2, x2: to.x, y2: to.y + NODE_H / 2 };
  }
  if (to.x + NODE_W <= from.x) {
    return { x1: from.x, y1: from.y + NODE_H / 2, x2: to.x + NODE_W, y2: to.y + NODE_H / 2 };
  }
  // Vertical arrows sit off-centre so they do not run over the node titles.
  const x = NODE_W * 0.72;
  if (to.y >= from.y + NODE_H) return { x1: from.x + x, y1: from.y + NODE_H, x2: to.x + x, y2: to.y };
  return { x1: from.x + x, y1: from.y, x2: to.x + x, y2: to.y + NODE_H };
}

/**
 * One lane per project, holding three kinds of block, top to bottom:
 * 1. Families: a parent with the workspaces it spawned or that stack on it, drawn as a tree.
 * 2. Workspaces with merge-order relations but no family, laid out left to right in merge order.
 * 3. Everything else, in a grid.
 * A child that lives in another project stays with its family, in the root's lane.
 */
export function layoutGraph(workspaces: CanvasWorkspace[], allEdges: CanvasEdge[]): GraphLayout {
  const byId = new Map(workspaces.map((ws) => [ws.id, ws]));
  const parentOf = (ws: CanvasWorkspace) => (ws.parent && byId.has(ws.parent.id) ? ws.parent : null);
  const children = new Map<string, CanvasWorkspace[]>();
  for (const ws of workspaces) {
    const parent = parentOf(ws);
    if (!parent) continue;
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id)!.push(ws);
  }
  for (const list of children.values()) list.sort(byRank);

  function familyOf(root: CanvasWorkspace): CanvasWorkspace[] {
    const out = [root];
    for (const kid of children.get(root.id) ?? []) out.push(...familyOf(kid));
    return out;
  }

  // A stacked child's connector already says "parent first"; do not repeat it as an arrow.
  const drawn = withoutImplied(allEdges).filter(
    (edge) => !(edge.kind === "stack" && byId.get(edge.to)?.parent?.id === edge.from),
  );

  const lanesByProject = new Map<string, CanvasWorkspace[]>();
  for (const ws of workspaces) {
    if (parentOf(ws)) continue;
    if (!lanesByProject.has(ws.project)) lanesByProject.set(ws.project, []);
    lanesByProject.get(ws.project)!.push(ws);
  }
  const bestRank = (roots: CanvasWorkspace[]) =>
    Math.min(...roots.flatMap((root) => familyOf(root).map((ws) => ws.priority.rank)));
  const lanesInOrder = [...lanesByProject.entries()].sort(([, a], [, b]) => bestRank(a) - bestRank(b));

  const lanes: Lane[] = [];
  const families: Family[] = [];
  const connectors: Connector[] = [];
  const nodes: PlacedNode[] = [];
  const position = new Map<string, PlacedNode>();
  let y = 0;
  let width = 0;

  function place(ws: CanvasWorkspace, x: number, top: number) {
    const node = { ws, x, y: top };
    nodes.push(node);
    position.set(ws.id, node);
  }

  /** Top-aligned tree growing rightward. */
  function placeTree(ws: CanvasWorkspace, x: number, top: number): { bottom: number; right: number } {
    place(ws, x, top);
    const kids = children.get(ws.id) ?? [];
    if (kids.length === 0) return { bottom: top + NODE_H, right: x + NODE_W };
    const childX = x + NODE_W + TREE_GAP_X;
    let cursor = top;
    let right = childX + NODE_W;
    const mids: Array<{ y: number; via: "spawned" | "stacked" }> = [];
    for (const kid of kids) {
      mids.push({ y: cursor + NODE_H / 2, via: kid.parent!.via });
      const sub = placeTree(kid, childX, cursor);
      cursor = sub.bottom + GAP_Y;
      right = Math.max(right, sub.right);
    }
    const spineX = x + NODE_W + TREE_GAP_X / 2;
    const parentMid = top + NODE_H / 2;
    const lastMid = mids[mids.length - 1].y;
    connectors.push({ x: x + NODE_W, y: parentMid - 1, width: TREE_GAP_X / 2, height: 2, via: "spine" });
    connectors.push({ x: spineX - 1, y: parentMid - 1, width: 2, height: lastMid - parentMid + 2, via: "spine" });
    for (const mid of mids) {
      connectors.push({ x: spineX, y: mid.y - 1, width: TREE_GAP_X / 2, height: 2, via: mid.via });
    }
    return { bottom: Math.max(top + NODE_H, cursor - GAP_Y), right };
  }

  for (const [project, roots] of lanesInOrder) {
    const sorted = [...roots].sort(byRank);
    const familyRoots = sorted.filter((ws) => children.has(ws.id));
    const singles = sorted.filter((ws) => !children.has(ws.id));
    const singleIds = new Set(singles.map((ws) => ws.id));
    const singleEdges = drawn.filter((edge) => singleIds.has(edge.from) && singleIds.has(edge.to));
    const linked = new Set(singleEdges.flatMap((edge) => [edge.from, edge.to]));
    let ordered = singles.filter((ws) => linked.has(ws.id));
    let loose = singles.filter((ws) => !linked.has(ws.id));

    const left = LANE_PAD;
    let cursor = y + LANE_HEADER + LANE_PAD;
    let laneRight = left + NODE_W;
    const claimed = new Set<string>();

    for (const root of familyRoots) {
      const top = cursor;
      const tree = placeTree(root, left + FAMILY_PAD, top + FAMILY_HEADER + FAMILY_PAD);
      const members = new Set(familyOf(root).map((ws) => ws.id));
      const box = {
        rootId: root.id,
        x: left,
        y: top,
        width: tree.right - left + FAMILY_PAD,
        height: tree.bottom - top + FAMILY_PAD,
        size: members.size,
      };
      families.push(box);

      // Outsiders with a merge relation to this family sit just right of its box, so
      // their arrows stay short instead of cutting across the tree connectors.
      const related = singles
        .filter((ws) => !claimed.has(ws.id))
        .filter((ws) =>
          drawn.some(
            (edge) => (edge.from === ws.id && members.has(edge.to)) || (edge.to === ws.id && members.has(edge.from)),
          ),
        );
      related.forEach((ws, row) => {
        claimed.add(ws.id);
        place(ws, box.x + box.width + GAP_X, top + FAMILY_HEADER + FAMILY_PAD + row * (NODE_H + GAP_Y));
      });
      const relatedBottom = related.length
        ? top + FAMILY_HEADER + FAMILY_PAD + related.length * (NODE_H + GAP_Y) - GAP_Y
        : top;
      laneRight = Math.max(laneRight, box.x + box.width + (related.length ? GAP_X + NODE_W : 0));
      cursor = Math.max(box.y + box.height, relatedBottom) + BLOCK_GAP;
    }

    ordered = ordered.filter((ws) => !claimed.has(ws.id));
    loose = loose.filter((ws) => !claimed.has(ws.id));
    if (ordered.length) {
      const depthOf = depths(
        ordered.map((ws) => ws.id),
        singleEdges,
      );
      const columns: CanvasWorkspace[][] = [];
      for (const ws of ordered) (columns[depthOf.get(ws.id) ?? 0] ??= []).push(ws);
      let tallest = 0;
      columns.forEach((column, d) => {
        column.forEach((ws, row) => place(ws, left + d * (NODE_W + GAP_X), cursor + row * (NODE_H + GAP_Y)));
        tallest = Math.max(tallest, column.length * (NODE_H + GAP_Y) - GAP_Y);
      });
      laneRight = Math.max(laneRight, left + columns.length * (NODE_W + GAP_X) - GAP_X);
      cursor += tallest + BLOCK_GAP;
    }

    if (loose.length) {
      const perRow = Math.max(MIN_LOOSE_COLUMNS, Math.floor((laneRight - left + GAP_Y) / (NODE_W + GAP_Y)));
      loose.forEach((ws, index) =>
        place(ws, left + (index % perRow) * (NODE_W + GAP_Y), cursor + Math.floor(index / perRow) * (NODE_H + GAP_Y)),
      );
      const rows = Math.ceil(loose.length / perRow);
      laneRight = Math.max(laneRight, left + Math.min(loose.length, perRow) * (NODE_W + GAP_Y) - GAP_Y);
      cursor += rows * (NODE_H + GAP_Y) - GAP_Y + BLOCK_GAP;
    }

    const height = cursor - BLOCK_GAP + LANE_PAD - y;
    lanes.push({ project, y, height });
    width = Math.max(width, laneRight + LANE_PAD);
    y += height + LANE_GAP;
  }

  const edges: PlacedEdge[] = [];
  for (const edge of drawn) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (from && to) edges.push({ edge, ...attach(from, to) });
  }

  return { width, height: Math.max(0, y - LANE_GAP), lanes, families, connectors, nodes, edges };
}
