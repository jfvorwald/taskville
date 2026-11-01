import {
  type AreaId,
  CITY_LAYOUT,
  type CityLayout,
  findPath,
  nodeById,
  type WorkstationSlot,
} from "../layout/index.ts";

// Navigation and presentation state (ARCHITECTURE.md 11). Pure TypeScript: no React, no
// three.js, no clock of its own. The caller feeds it what the recorded state says (`sync`) and
// the time (`tick`); the same inputs at the same times give the same positions. Walking is
// interpolation, never a recorded fact, so nothing here is written back to the store.

/** Derived on the client, never stored. */
export type PresentationState =
  | "arriving"
  | "walking"
  | "working"
  | "waiting"
  | "idle"
  | "departing"
  | "stuck";

/** What an agent shows once it stands still, from the recorded state. */
export type RestState = "working" | "waiting" | "idle";

/** What the recorded state asks of one agent. */
export interface NavIntent {
  readonly id: string;
  /** Destination area; `null` keeps the current destination (or the plaza for a new agent). */
  readonly area: AreaId | null;
  /** Needs you: stop at the nearest safe point (or stay at the workstation). */
  readonly hold?: boolean;
  readonly rest?: RestState;
  /** A subagent's parent: it appears at, and leaves by, the parent's building. */
  readonly parentId?: string;
}

/** One agent's presentation. Live object: updated in place by `sync` and `tick`. */
export interface NavAgent {
  readonly id: string;
  /** World position (meters, ground plane) and heading (yaw, `(sin, cos)` is forward). */
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly state: PresentationState;
  /** Walking toward its work: the label's "on the way" mark. */
  readonly onTheWay: boolean;
  /** Reserved workstation slot, if any. */
  readonly slotId: string | null;
  /** Waiting in line for a slot in a full area. */
  readonly queued: boolean;
  /** Finished departing; drop it from the scene and call `prune`. */
  readonly gone: boolean;
}

export interface NavigatorOptions {
  layout?: CityLayout;
  /** Walking speed, m/s. */
  speed?: number;
  /** Personal space while walking, m. */
  spacing?: number;
  /** Sideways offset from the street centerline while walking, m (keeps two-way traffic apart). */
  lane?: number;
  /** How long a walker waits behind another before walking on anyway, ms. */
  yieldMs?: number;
  reducedMotion?: boolean;
}

export interface SyncOptions {
  /** Put new agents straight at their destination (the first snapshot: they were already there). */
  place?: boolean;
}

export interface Navigator {
  /** Applies the recorded state. Agents missing from `intents` depart. */
  sync(intents: readonly NavIntent[], options?: SyncOptions): void;
  /** Advances to `nowMs` (any monotonic clock). The first call only sets the clock. */
  tick(nowMs: number): void;
  get(id: string): NavAgent | undefined;
  /** Every agent, departing ones included, in the order they first appeared. */
  list(): readonly NavAgent[];
  /** Forgets agents that have finished departing. */
  prune(): void;
  /** On: every walk snaps to its end on the next tick. */
  setReducedMotion(on: boolean): void;
}

interface Waypoint {
  x: number;
  z: number;
  /** A graph node, or for a free point (a queue spot) the node it is reached from. */
  node: string;
  free?: boolean;
}

type Goal =
  | { kind: "stay" }
  | { kind: "slot"; slot: WorkstationSlot }
  | { kind: "queue"; area: AreaId }
  | { kind: "safe"; node: string }
  | { kind: "exit"; node: string };

interface Walker {
  view: {
    id: string;
    x: number;
    z: number;
    heading: number;
    state: PresentationState;
    onTheWay: boolean;
    slotId: string | null;
    queued: boolean;
    gone: boolean;
  };
  /** Position on the street centerline; `view` adds the lane offset. */
  lx: number;
  lz: number;
  offX: number;
  offZ: number;
  path: Waypoint[];
  last: Waypoint;
  progressed: number;
  goal: Goal;
  area: AreaId | null;
  safeNode: string | null;
  hold: boolean;
  rest: RestState;
  departing: boolean;
  firstTrip: boolean;
  noPath: boolean;
  blockedMs: number;
  exitNode: string;
}

const STEP_MS = 100;
const LANE_FADE_M = 1;
const QUEUE_SIDE_X = 2.6;
const QUEUE_RANK_X = 0.8;
const QUEUE_BACK_Z = 0.8;
const SPAWN_RING = 8;
const SPAWN_RADIUS = 1.75;
/** Closer than this, even the walker with the right of way waits. */
const HARD_RADIUS = 0.55;

export function createNavigator(options: NavigatorOptions = {}): Navigator {
  const layout = options.layout ?? CITY_LAYOUT;
  const speed = options.speed ?? 1.6;
  const spacing = options.spacing ?? 0.7;
  const lane = options.lane ?? 0.3;
  const yieldMs = options.yieldMs ?? 1500;
  let reducedMotion = options.reducedMotion ?? false;

  const walkers = new Map<string, Walker>();
  let listCache: NavAgent[] | null = null;
  const slotOwner = new Map<string, string>();
  const safeOwner = new Map<string, string>();
  const queues = new Map<AreaId, string[]>();
  const slotsByArea = new Map<AreaId, WorkstationSlot[]>();
  for (const s of layout.slots) {
    const list = slotsByArea.get(s.areaId) ?? [];
    list.push(s);
    slotsByArea.set(s.areaId, list);
  }
  const anchorOf = new Map(layout.areas.map((a) => [a.id, a.anchorId]));
  const plazaNodes = layout.graph.nodes.filter((n) => n.kind === "plaza").map((n) => n.id);
  let lastTick: number | undefined;

  const pos = (node: string) => {
    const n = nodeById(layout, node);
    if (!n) throw new Error(`unknown navigation node ${node}`);
    return n;
  };
  const point = (node: string): Waypoint => {
    const n = pos(node);
    return { x: n.x, z: n.z, node };
  };
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);

  // Slots and queues.

  function queueSpot(area: AreaId, index: number): Waypoint {
    const anchor = anchorOf.get(area) as string;
    const a = pos(anchor);
    const side = index % 2 === 0 ? 1 : -1;
    const rank = Math.floor(index / 2);
    return {
      x: a.x + side * (QUEUE_SIDE_X + rank * QUEUE_RANK_X),
      z: a.z - QUEUE_BACK_Z,
      node: anchor,
      free: true,
    };
  }

  function releaseSlot(w: Walker) {
    const id = w.view.slotId;
    if (id === null) return;
    slotOwner.delete(id);
    w.view.slotId = null;
    const slot = layout.slots.find((s) => s.id === id);
    if (!slot) return;
    const line = queues.get(slot.areaId) ?? [];
    // The head of the line, skipping anyone no longer waiting for this area.
    let q: Walker | undefined;
    while (q === undefined && line.length > 0) {
      const next = walkers.get(line.shift() as string);
      if (next?.view.queued && next.area === slot.areaId) q = next;
      // Dropped from the line, so it is no longer in it (retarget would otherwise wait on it forever).
      else if (next) next.view.queued = false;
    }
    if (q === undefined) return;
    q.view.queued = false;
    reserve(q, slot);
    retarget(q);
    refreshQueue(slot.areaId);
  }

  /** Leaves the line it stands in, which is not `w.area` once `sync` has changed the area. */
  function leaveQueue(w: Walker) {
    if (!w.view.queued) return;
    w.view.queued = false;
    for (const [area, line] of queues) {
      const i = line.indexOf(w.view.id);
      if (i < 0) continue;
      line.splice(i, 1);
      refreshQueue(area);
    }
  }

  /** Queue spots move up when the line shortens. */
  function refreshQueue(area: AreaId) {
    for (const id of queues.get(area) ?? []) {
      const q = walkers.get(id);
      if (q && !q.hold) plan(q);
    }
  }

  function reserve(w: Walker, slot: WorkstationSlot) {
    slotOwner.set(slot.id, w.view.id);
    w.view.slotId = slot.id;
    w.goal = { kind: "slot", slot };
  }

  function claimArea(w: Walker, area: AreaId) {
    const free = (slotsByArea.get(area) ?? []).find((s) => !slotOwner.has(s.id));
    if (free) {
      reserve(w, free);
      return;
    }
    const line = queues.get(area) ?? [];
    line.push(w.view.id);
    queues.set(area, line);
    w.view.queued = true;
    w.goal = { kind: "queue", area };
  }

  function releaseSafe(w: Walker) {
    if (w.safeNode !== null) safeOwner.delete(w.safeNode);
    w.safeNode = null;
  }

  // Planning.

  /** Graph nodes the walker can head for from where it stands, with the straight distance. */
  function starts(w: Walker): Array<{ node: string; cost: number }> {
    const here = { x: w.lx, z: w.lz };
    const out: Array<{ node: string; cost: number }> = [];
    const add = (node: string) => {
      if (!out.some((s) => s.node === node)) out.push({ node, cost: dist(here, pos(node)) });
    };
    const next = w.path[0];
    if (next && !next.free) add(next.node);
    add(w.last.node);
    if (next?.free) add(next.node);
    return out;
  }

  function cheapest(w: Walker, target: string) {
    let best: { nodeIds: string[]; total: number } | null = null;
    for (const s of starts(w)) {
      const p = findPath(layout, s.node, target);
      if (p === null) continue;
      const total = s.cost + p.length;
      if (best === null || total < best.total - 1e-9) best = { nodeIds: p.nodeIds, total };
    }
    return best;
  }

  function targetOf(w: Walker): { node: string; free?: Waypoint } | null {
    const g = w.goal;
    switch (g.kind) {
      case "stay":
        return null;
      case "slot":
        return { node: g.slot.nodeId };
      case "queue": {
        const index = (queues.get(g.area) ?? []).indexOf(w.view.id);
        const spot = queueSpot(g.area, Math.max(0, index));
        return { node: spot.node, free: spot };
      }
      case "safe":
      case "exit":
        return { node: g.node };
    }
  }

  function plan(w: Walker) {
    w.noPath = false;
    w.progressed = 0;
    w.blockedMs = 0;
    const t = targetOf(w);
    if (t === null) {
      // Stop where it stands: at the waypoint just reached, or the next one when mid-street.
      const next = w.path[0];
      w.path = next && dist(next, { x: w.lx, z: w.lz }) > 1e-9 ? [next] : [];
      return;
    }
    const best = cheapest(w, t.node);
    if (best === null) {
      w.path = [];
      w.noPath = true;
      return;
    }
    const path = best.nodeIds.map(point);
    if (t.free) path.push(t.free);
    while (path.length > 0 && dist(path[0] as Waypoint, { x: w.lx, z: w.lz }) < 1e-9) {
      w.last = path.shift() as Waypoint;
    }
    w.path = path;
  }

  function nearestFreeSafe(w: Walker): string | null {
    let best: { node: string; total: number } | null = null;
    for (const node of plazaNodes) {
      const owner = safeOwner.get(node);
      if (owner !== undefined && owner !== w.view.id) continue;
      const p = cheapest(w, node);
      if (p !== null && (best === null || p.total < best.total - 1e-9)) {
        best = { node, total: p.total };
      }
    }
    return best?.node ?? null;
  }

  const atRest = (w: Walker) => w.path.length === 0;

  function retarget(w: Walker) {
    if (w.departing) {
      releaseSafe(w);
      leaveQueue(w);
      releaseSlot(w);
      w.goal = { kind: "exit", node: w.exitNode };
      plan(w);
      return;
    }
    if (w.hold) {
      // Already has a safe point: it keeps it (a slot handed over meanwhile is only recorded).
      if (w.safeNode !== null) {
        if (w.goal.kind !== "safe") {
          w.goal = { kind: "safe", node: w.safeNode };
          plan(w);
        }
        return;
      }
      // Already standing at its workstation or in line: it stops right there.
      if (atRest(w) && (w.goal.kind === "slot" || w.goal.kind === "queue")) return;
      const node = nearestFreeSafe(w);
      if (node === null) {
        w.goal = { kind: "stay" };
      } else {
        safeOwner.set(node, w.view.id);
        w.safeNode = node;
        w.goal = { kind: "safe", node };
      }
      plan(w);
      return;
    }
    releaseSafe(w);
    const area = w.area;
    if (area === null) {
      w.goal = { kind: "stay" };
      plan(w);
      return;
    }
    const slotId = w.view.slotId;
    const slot = slotId === null ? undefined : layout.slots.find((s) => s.id === slotId);
    if (slot && slot.areaId === area) {
      w.goal = { kind: "slot", slot };
    } else if (w.view.queued && w.goal.kind === "queue" && w.goal.area === area) {
      // Still in line for the same area.
    } else {
      leaveQueue(w);
      releaseSlot(w);
      claimArea(w, area);
    }
    plan(w);
  }

  // Spawning.

  function spawnPoint(w: Walker, parentId: string | undefined): Waypoint {
    const parent = parentId === undefined ? undefined : walkers.get(parentId);
    const parentSlot = parent?.view.slotId;
    if (parentSlot != null) {
      const s = layout.slots.find((x) => x.id === parentSlot);
      if (s) return point(s.anchorId);
    }
    // The plaza point nearest its destination that nobody is standing on.
    const t = targetOf(w);
    const ranked = plazaNodes
      .map((node, i) => ({
        node,
        i,
        cost: t === null ? i : (findPath(layout, node, t.node)?.length ?? Number.POSITIVE_INFINITY),
      }))
      .sort((a, b) => a.cost - b.cost || a.i - b.i);
    const taken = (at: { x: number; z: number }) => {
      for (const o of walkers.values()) {
        if (o !== w && !o.view.gone && dist(o.view, at) < spacing * 1.5) return true;
      }
      return false;
    };
    const free = ranked.find((r) => !safeOwner.has(r.node) && !taken(pos(r.node)));
    if (free) return point(free.node);
    // Every plaza point is taken: a free spot on a ring inside the plaza, joined to its center.
    const c = pos(layout.plazaNodeId);
    for (let k = 0; k < SPAWN_RING; k++) {
      const a = ((k + 0.5) / SPAWN_RING) * 2 * Math.PI;
      const at = { x: c.x + Math.cos(a) * SPAWN_RADIUS, z: c.z + Math.sin(a) * SPAWN_RADIUS };
      if (!taken(at)) return { ...at, node: layout.plazaNodeId, free: true };
    }
    return point(layout.plazaNodeId);
  }

  function create(intent: NavIntent): Walker {
    const start = point(layout.plazaNodeId);
    const w: Walker = {
      view: {
        id: intent.id,
        x: start.x,
        z: start.z,
        heading: 0,
        state: "idle",
        onTheWay: false,
        slotId: null,
        queued: false,
        gone: false,
      },
      lx: start.x,
      lz: start.z,
      offX: 0,
      offZ: 0,
      path: [],
      last: start,
      progressed: 0,
      goal: { kind: "stay" },
      area: intent.area,
      safeNode: null,
      hold: false,
      rest: intent.rest ?? "working",
      departing: false,
      firstTrip: true,
      noPath: false,
      blockedMs: 0,
      exitNode: layout.plazaNodeId,
    };
    walkers.set(intent.id, w);
    listCache = null;
    return w;
  }

  function moveTo(w: Walker, at: Waypoint) {
    w.lx = at.x;
    w.lz = at.z;
    w.last = at;
    w.view.x = w.lx + w.offX;
    w.view.z = w.lz + w.offZ;
  }

  function snap(w: Walker) {
    const end = w.path[w.path.length - 1];
    if (end !== undefined) moveTo(w, end);
    w.path = [];
    w.offX = 0;
    w.offZ = 0;
    settle(w);
  }

  // Stepping.

  function settle(w: Walker) {
    if (w.path.length > 0) return;
    w.firstTrip = false;
    if (w.departing) w.view.gone = true;
    if (w.goal.kind === "slot") w.view.heading = w.goal.slot.facing;
  }

  function remaining(w: Walker): number {
    let total = 0;
    let from = { x: w.lx, z: w.lz };
    for (const p of w.path) {
      total += dist(from, p);
      from = p;
    }
    return total;
  }

  /** Unit direction toward the next waypoint, or null when standing still. */
  function heading(w: Walker): [number, number] | null {
    const next = w.path[0];
    if (next === undefined) return null;
    const len = Math.hypot(next.x - w.lx, next.z - w.lz);
    return len > 0 ? [(next.x - w.lx) / len, (next.z - w.lz) / len] : null;
  }

  /** Is `other` in the corridor just ahead of `from`, walking along (dx, dz)? */
  function inFront(from: Walker, dx: number, dz: number, other: Walker): boolean {
    const ox = other.view.x - from.view.x;
    const oz = other.view.z - from.view.z;
    const along = ox * dx + oz * dz;
    if (along <= 0.01 || along >= spacing) return false;
    return Math.abs(ox * dz - oz * dx) < spacing * 0.7;
  }

  /**
   * Local spacing. A walker waits for anyone in the corridor just ahead. When two walkers block
   * each other, the one with the smaller id has the right of way (unless they are already very
   * close) and the other backs off along its street to make room.
   */
  function blocked(w: Walker, dx: number, dz: number): "clear" | "wait" | "back" {
    let result: "clear" | "wait" | "back" = "clear";
    for (const o of walkers.values()) {
      if (o === w || o.view.gone || !inFront(w, dx, dz, o)) continue;
      const od = heading(o);
      const mutual = od !== null && inFront(o, od[0], od[1], w);
      if (!mutual) return "wait";
      if (w.view.id > o.view.id) result = "back";
      else if (dist(w.view, o.view) < HARD_RADIUS && result === "clear") result = "wait";
    }
    return result;
  }

  /** Steps back toward the last waypoint (never past it), staying on the planned street. */
  function backOff(w: Walker, meters: number) {
    const d = Math.hypot(w.last.x - w.lx, w.last.z - w.lz);
    if (d < 1e-9) return;
    const m = Math.min(d, meters);
    w.lx += ((w.last.x - w.lx) / d) * m;
    w.lz += ((w.last.z - w.lz) / d) * m;
    w.progressed = Math.max(0, w.progressed - m);
    w.view.x = w.lx + w.offX;
    w.view.z = w.lz + w.offZ;
  }

  function step(w: Walker, ms: number) {
    if (w.path.length === 0) return;
    const dir = heading(w);
    const dx = dir?.[0] ?? 0;
    const dz = dir?.[1] ?? 0;
    if (dir !== null) w.view.heading = Math.atan2(dx, dz);
    const block = dir === null ? "clear" : blocked(w, dx, dz);
    if (block !== "clear") {
      w.blockedMs += ms;
      if (w.blockedMs < yieldMs) {
        if (block === "back") backOff(w, (speed * ms) / 2000);
        return;
      }
    } else {
      w.blockedMs = 0;
    }
    let budget = (speed * ms) / 1000;
    while (budget > 0 && w.path.length > 0) {
      const p = w.path[0] as Waypoint;
      const d = Math.hypot(p.x - w.lx, p.z - w.lz);
      if (d <= budget) {
        moveTo(w, p);
        w.path.shift();
        budget -= d;
        w.progressed += d;
      } else {
        w.lx += ((p.x - w.lx) / d) * budget;
        w.lz += ((p.z - w.lz) / d) * budget;
        w.progressed += budget;
        budget = 0;
      }
    }
    // Lane offset: to the walker's right, eased in and out near both ends of the walk.
    const fade = Math.max(0, Math.min(1, Math.min(w.progressed, remaining(w)) / LANE_FADE_M));
    const ease = Math.min(1, ms / 200);
    w.offX += (dz * lane * fade - w.offX) * ease;
    w.offZ += (-dx * lane * fade - w.offZ) * ease;
    if (w.path.length === 0) {
      w.offX = 0;
      w.offZ = 0;
      settle(w);
    }
    w.view.x = w.lx + w.offX;
    w.view.z = w.lz + w.offZ;
  }

  function present(w: Walker) {
    const v = w.view;
    v.x = w.lx + w.offX;
    v.z = w.lz + w.offZ;
    const moving = w.path.length > 0;
    v.onTheWay = moving && !w.departing && !w.hold;
    if (w.departing) v.state = "departing";
    else if (moving) v.state = w.firstTrip ? "arriving" : "walking";
    else if (w.noPath || w.hold) v.state = "stuck";
    else if (v.queued) v.state = "waiting";
    else v.state = w.rest;
  }

  return {
    sync(intents, syncOptions = {}) {
      const seen = new Set<string>();
      const fresh: Walker[] = [];
      for (const intent of intents) {
        seen.add(intent.id);
        let w = walkers.get(intent.id);
        const isNew = w === undefined;
        if (w === undefined) w = create(intent);
        const hold = intent.hold === true;
        const area = intent.area ?? w.area;
        const revived = w.departing;
        w.rest = intent.rest ?? "working";
        if (!isNew && !revived && hold === w.hold && area === w.area) continue;
        w.hold = hold;
        w.area = area;
        if (revived) {
          w.departing = false;
          w.view.gone = false;
        }
        if (isNew) {
          w.hold = false;
          retarget(w);
          const spawn = spawnPoint(w, intent.parentId);
          w.exitNode = spawn.node;
          moveTo(w, spawn);
          // Route from the spawn point onto the streets, not along the path planned from the plaza.
          w.path = [];
          plan(w);
          // Placed: a held agent was already at its workstation or in line, and stops there.
          if (hold && syncOptions.place === true) snap(w);
          w.hold = hold;
          if (hold) retarget(w);
          fresh.push(w);
        } else {
          retarget(w);
        }
      }
      for (const w of walkers.values()) {
        if (seen.has(w.view.id) || w.departing) continue;
        w.departing = true;
        w.hold = false;
        retarget(w);
      }
      if (syncOptions.place === true) {
        for (const w of fresh) snap(w);
      }
      for (const w of walkers.values()) present(w);
    },

    tick(nowMs) {
      const dt = lastTick === undefined ? 0 : Math.max(0, nowMs - lastTick);
      lastTick = nowMs;
      if (reducedMotion) {
        for (const w of walkers.values()) snap(w);
      } else {
        let left = dt;
        while (left > 0) {
          const ms = Math.min(STEP_MS, left);
          for (const w of walkers.values()) step(w, ms);
          left -= ms;
        }
        for (const w of walkers.values()) settle(w);
      }
      for (const w of walkers.values()) present(w);
    },

    get: (id) => walkers.get(id)?.view,

    list() {
      if (listCache === null) listCache = [...walkers.values()].map((w) => w.view);
      return listCache;
    },

    prune() {
      for (const [id, w] of walkers) {
        if (!w.view.gone) continue;
        walkers.delete(id);
        listCache = null;
      }
    },

    setReducedMotion(on) {
      reducedMotion = on;
    },
  };
}
