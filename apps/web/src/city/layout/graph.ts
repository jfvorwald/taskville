import type { CityLayout, NavNode } from "./types.ts";

interface Adjacency {
  nodes: Map<string, NavNode>;
  neighbors: Map<string, Array<{ to: string; length: number }>>;
}

// One index per layout object; the layout is immutable data, so this never goes stale.
const indexes = new WeakMap<CityLayout, Adjacency>();

function indexOf(layout: CityLayout): Adjacency {
  const cached = indexes.get(layout);
  if (cached) return cached;
  const nodes = new Map<string, NavNode>();
  const neighbors = new Map<string, Array<{ to: string; length: number }>>();
  for (const node of layout.graph.nodes) {
    nodes.set(node.id, node);
    neighbors.set(node.id, []);
  }
  for (const e of layout.graph.edges) {
    neighbors.get(e.from)?.push({ to: e.to, length: e.length });
    neighbors.get(e.to)?.push({ to: e.from, length: e.length });
  }
  const built = { nodes, neighbors };
  indexes.set(layout, built);
  return built;
}

export function nodeById(layout: CityLayout, id: string): NavNode | undefined {
  return indexOf(layout).nodes.get(id);
}

/** Ids of every node reachable from `start`, including `start`. Empty for an unknown id. */
export function reachableFrom(layout: CityLayout, start: string): Set<string> {
  const { nodes, neighbors } = indexOf(layout);
  const seen = new Set<string>();
  if (!nodes.has(start)) return seen;
  const stack = [start];
  seen.add(start);
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    for (const n of neighbors.get(id) ?? []) {
      if (seen.has(n.to)) continue;
      seen.add(n.to);
      stack.push(n.to);
    }
  }
  return seen;
}

export interface GraphPath {
  /** Node ids from start to goal, inclusive. */
  nodeIds: string[];
  /** Total length in meters. */
  length: number;
}

/** Shortest path by edge length (Dijkstra), or null when an id is unknown or unreachable. */
export function findPath(layout: CityLayout, from: string, to: string): GraphPath | null {
  const { nodes, neighbors } = indexOf(layout);
  if (!nodes.has(from) || !nodes.has(to)) return null;
  const best = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  const open = new Set<string>([from]);
  const done = new Set<string>();
  while (open.size > 0) {
    let current: string | undefined;
    let currentCost = Number.POSITIVE_INFINITY;
    for (const id of open) {
      const cost = best.get(id) ?? Number.POSITIVE_INFINITY;
      if (cost < currentCost) {
        current = id;
        currentCost = cost;
      }
    }
    if (current === undefined) break;
    open.delete(current);
    if (current === to) break;
    done.add(current);
    for (const n of neighbors.get(current) ?? []) {
      if (done.has(n.to)) continue;
      const cost = currentCost + n.length;
      if (cost < (best.get(n.to) ?? Number.POSITIVE_INFINITY)) {
        best.set(n.to, cost);
        previous.set(n.to, current);
        open.add(n.to);
      }
    }
  }
  const length = best.get(to);
  if (length === undefined) return null;
  const nodeIds = [to];
  while (nodeIds[0] !== from) {
    const prev = previous.get(nodeIds[0] as string);
    if (prev === undefined) return null;
    nodeIds.unshift(prev);
  }
  return { nodeIds, length };
}
