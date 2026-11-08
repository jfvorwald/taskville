import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import type { MovementLabel } from "../../../src/city/movement/labels.ts";
import {
  type BreakDestination,
  createNavigator,
  type NavAgent,
  type NavIntent,
  type Navigator,
} from "../../../src/city/movement/navigator.ts";
import { motionSignals } from "../../../src/city/runtime/motion-signals.ts";

// Break trips (break time design, M9.05). An agent whose recorded state is Waiting may carry a
// `breakSpot`: it walks from its workstation to a break site spot or a plaza node and stands
// there, still presenting its rest state. The slot stays reserved. Removing the spot, new work or
// needs-you ends the break with the existing navigator rules.

const L = CITY_LAYOUT;
const slot = (id: string) => {
  const s = L.slots.find((x) => x.id === id);
  if (!s) throw new Error(`no slot ${id}`);
  return s;
};
const site = L.breakSites[0];
const spot = site?.spots[0];
if (!site || !spot) throw new Error("layout has no break spot");
const BAR: BreakDestination = { kind: "site", nodeId: spot.nodeId };
const plazaNodes = L.graph.nodes.filter((n) => n.kind === "plaza");
const PLAZA_BREAK: BreakDestination = { kind: "plaza", index: 1 };
const plazaPoint = plazaNodes[1] as (typeof plazaNodes)[number];

// The seeded fuzz runs simulate minutes of walking per case; alone they take a second or two, but
// under parallel load they passed vitest's 5 s default (M9.11). Not shrunk, only given room.
const FUZZ_TIMEOUT_MS = 30_000;

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
const must = (nav: Navigator, id: string): NavAgent => {
  const a = nav.get(id);
  if (!a) throw new Error(`no agent ${id}`);
  return a;
};
function run(nav: Navigator, clock: { t: number }, ms: number, each?: () => void) {
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += 50;
    nav.tick(clock.t);
    each?.();
  }
}
const waiting = (
  id: string,
  area: NavIntent["area"],
  extra: Partial<NavIntent> = {},
): NavIntent => ({
  id,
  area,
  rest: "waiting",
  ...extra,
});
const isWalking = (a: NavAgent) =>
  a.state === "walking" || a.state === "arriving" || a.state === "departing";

/** An agent seated at workshop:0, waiting, with the clock at 0. */
function seated() {
  const nav = createNavigator();
  const clock = { t: 0 };
  nav.sync([waiting("a", "workshop")], { place: true });
  nav.tick(clock.t);
  return { nav, clock };
}

describe("navigator break trips", () => {
  it("walks from its slot to a break site spot and stands there, still waiting", () => {
    const { nav, clock } = seated();
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 1_000);
    expect(must(nav, "a").state).toBe("walking");

    run(nav, clock, 90_000);
    const a = must(nav, "a");
    expect(dist(a, spot)).toBeLessThan(1e-6);
    expect(a.state).toBe("waiting");
    expect(a.onTheWay).toBe(false);
    // The workstation stays reserved for the way back.
    expect(a.slotId).toBe("workshop:0");
  });

  it("walks to a plaza node for a stroll or chat", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: PLAZA_BREAK })]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "a"), plazaPoint)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("waiting");
  });

  it("does not move while standing at a break spot", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    const before = { x: must(nav, "a").x, z: must(nav, "a").z };
    run(nav, clock, 10_000, () => {
      expect(dist(must(nav, "a"), before)).toBeLessThan(1e-9);
      expect(isWalking(must(nav, "a"))).toBe(false);
    });
  });

  it("does not count a standing break as moving for the idle throttle", () => {
    const { nav, clock } = seated();
    const labels = (): MovementLabel[] => {
      const a = must(nav, "a");
      return [
        {
          id: "a",
          name: "a",
          status: "Waiting",
          onTheWay: a.onTheWay,
          state: a.state,
          urgent: false,
        },
      ];
    };
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 1_000);
    expect(motionSignals(labels(), false, false).agentsMoving).toBe(true);
    run(nav, clock, 90_000);
    expect(motionSignals(labels(), false, false).agentsMoving).toBe(false);
  });

  it("walks back to its slot when the break destination is removed", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop")]);
    nav.tick(clock.t + 50);
    clock.t += 50;
    expect(must(nav, "a").state).toBe("walking");
    run(nav, clock, 90_000);
    const a = must(nav, "a");
    expect(dist(a, slot("workshop:0"))).toBeLessThan(1e-6);
    expect(a.slotId).toBe("workshop:0");
    expect(a.state).toBe("waiting");
  });

  it("goes to a plaza safe point when needs-you arrives mid-walk, then back to its slot", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 1_500);
    nav.sync([waiting("a", "workshop", { hold: true })]);
    run(nav, clock, 90_000);
    const held = must(nav, "a");
    expect(held.state).toBe("stuck");
    expect(plazaNodes.some((n) => dist(n, held) < 1e-6)).toBe(true);

    // The break is over: it returns to its workstation, not to the bar.
    nav.sync([waiting("a", "workshop")]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
  });

  it("leaves a break spot for a plaza safe point on needs-you", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop", { hold: true })]);
    run(nav, clock, 90_000);
    const held = must(nav, "a");
    expect(held.state).toBe("stuck");
    expect(plazaNodes.some((n) => dist(n, held) < 1e-6)).toBe(true);
  });

  it("stays put when needs-you arrives at a plaza break node", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: PLAZA_BREAK })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop", { hold: true })]);
    run(nav, clock, 10_000);
    expect(dist(must(nav, "a"), plazaPoint)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("stuck");
  });

  it("returns to the break spot when hold clears and the intent still carries it", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop", { hold: true, breakSpot: BAR })]);
    run(nav, clock, 90_000);
    expect(plazaNodes.some((n) => dist(n, must(nav, "a")) < 1e-6)).toBe(true);
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "a"), spot)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("waiting");
  });

  it("cancels the break and walks to the new area when work arrives elsewhere", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([{ id: "a", area: "archives", rest: "working", breakSpot: BAR }]);
    expect(must(nav, "a").slotId).toBe("archives:0");
    run(nav, clock, 120_000);
    const a = must(nav, "a");
    expect(dist(a, slot("archives:0"))).toBeLessThan(1e-6);
    expect(a.state).toBe("working");
  });

  it("keeps a cancelled break cancelled while the intent repeats, until a new breakSpot arrives", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    const work = { id: "a", area: "archives", rest: "working", breakSpot: BAR } as const;
    nav.sync([work]);
    for (let i = 0; i < 4; i++) {
      run(nav, clock, 30_000);
      nav.sync([work]);
    }
    run(nav, clock, 120_000);
    const a = must(nav, "a");
    expect(dist(a, slot("archives:0"))).toBeLessThan(1e-6);
    expect(a.state).toBe("working");
    expect(a.slotId).toBe("archives:0");

    // The intent drops the spot, then a new one arrives later: the agent goes on break again.
    nav.sync([{ id: "a", area: "archives", rest: "working" }]);
    run(nav, clock, 1_000);
    expect(dist(must(nav, "a"), slot("archives:0"))).toBeLessThan(1e-6);
    nav.sync([waiting("a", "archives", { breakSpot: BAR })]);
    run(nav, clock, 120_000);
    expect(dist(must(nav, "a"), spot)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("waiting");
  });

  it("treats a different breakSpot after a cancelled break as new", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([{ id: "a", area: "archives", rest: "working", breakSpot: BAR }]);
    run(nav, clock, 120_000);
    nav.sync([waiting("a", "archives", { breakSpot: PLAZA_BREAK })]);
    run(nav, clock, 120_000);
    expect(dist(must(nav, "a"), plazaPoint)).toBeLessThan(1e-6);
  });

  it("places a new agent with a break destination straight at the spot (history)", () => {
    const nav = createNavigator();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })], { place: true });
    nav.tick(0);
    const a = must(nav, "a");
    expect(dist(a, spot)).toBeLessThan(1e-6);
    expect(a.state).toBe("waiting");
    expect(a.slotId).toBe("workshop:0");
  });

  it("snaps break trips under reduced motion", () => {
    const nav = createNavigator({ reducedMotion: true });
    nav.sync([waiting("a", "workshop")], { place: true });
    nav.tick(0);
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    nav.tick(16);
    expect(dist(must(nav, "a"), spot)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("waiting");
    nav.sync([waiting("a", "workshop")]);
    nav.tick(32);
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
  });
  // Plaza nodes are shared ground: a needs-you safe point and a plaza break never stack agents.
  // Rule: a plaza break never takes a node held as a needs-you safe point (that agent keeps it;
  // the break agent stays at its workstation), and a needs-you agent never picks a safe point on a
  // node another agent is on or heading to for a break (the break agent is not displaced).
  describe("plaza nodes are never shared", () => {
    const twoSeated = (ids: string[]) => {
      const nav = createNavigator();
      const clock = { t: 0 };
      nav.sync(
        ids.map((id) => waiting(id, "workshop")),
        { place: true },
      );
      nav.tick(clock.t);
      return { nav, clock };
    };
    const atNode = (a: NavAgent) => plazaNodes.findIndex((n) => dist(n, a) < 1e-6);
    /** The plaza node index agent "a" takes as its safe point when alone and needs-you. */
    function safeIndexOfA(): number {
      const { nav, clock } = twoSeated(["a", "b"]);
      nav.sync([waiting("a", "workshop", { breakSpot: BAR }), waiting("b", "workshop")]);
      run(nav, clock, 90_000);
      nav.sync([waiting("a", "workshop", { hold: true }), waiting("b", "workshop")]);
      run(nav, clock, 90_000);
      const k = atNode(must(nav, "a"));
      expect(k).toBeGreaterThanOrEqual(0);
      return k;
    }

    it("keeps a plaza break off a node held as a needs-you safe point", () => {
      const k = safeIndexOfA();
      const { nav, clock } = twoSeated(["a", "b"]);
      nav.sync([waiting("a", "workshop", { breakSpot: BAR }), waiting("b", "workshop")]);
      run(nav, clock, 90_000);
      nav.sync([waiting("a", "workshop", { hold: true }), waiting("b", "workshop")]);
      run(nav, clock, 90_000);
      const heldAt = { x: must(nav, "a").x, z: must(nav, "a").z };
      nav.sync([
        waiting("a", "workshop", { hold: true }),
        waiting("b", "workshop", { breakSpot: { kind: "plaza", index: k } }),
      ]);
      run(nav, clock, 90_000);
      const a = must(nav, "a");
      const b = must(nav, "b");
      expect(dist(a, heldAt)).toBeLessThan(1e-6);
      expect(a.state).toBe("stuck");
      expect(dist(a, b)).toBeGreaterThan(0.1);
      // The rule: b yields and waits at its own workstation.
      expect(dist(b, slot("workshop:1"))).toBeLessThan(1e-6);
    });

    it("resumes a yielded plaza break once the blocking needs-you agent leaves the node", () => {
      const k = safeIndexOfA();
      const { nav, clock } = twoSeated(["a", "b"]);
      nav.sync([waiting("a", "workshop", { breakSpot: BAR }), waiting("b", "workshop")]);
      run(nav, clock, 90_000);
      nav.sync([waiting("a", "workshop", { hold: true }), waiting("b", "workshop")]);
      run(nav, clock, 90_000);
      const bIntent = waiting("b", "workshop", { breakSpot: { kind: "plaza", index: k } });
      nav.sync([waiting("a", "workshop", { hold: true }), bIntent]);
      run(nav, clock, 90_000);
      expect(dist(must(nav, "b"), slot("workshop:1"))).toBeLessThan(1e-6);

      // The hold clears and a walks back to its workstation; b's intent never changes.
      nav.sync([waiting("a", "workshop"), bIntent]);
      run(nav, clock, 90_000);
      expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
      // One more sync with the unchanged intent (re-evaluation on the next sync).
      nav.sync([waiting("a", "workshop"), bIntent]);
      run(nav, clock, 90_000);
      const b = must(nav, "b");
      expect(atNode(b)).toBe(k);
      expect(b.state).toBe("waiting");
      expect(dist(must(nav, "a"), b)).toBeGreaterThan(0.1);
    });

    it("keeps a needs-you agent off a node a break agent is standing on", () => {
      const k = safeIndexOfA();
      const { nav, clock } = twoSeated(["a", "b"]);
      nav.sync([
        waiting("a", "workshop", { breakSpot: BAR }),
        waiting("b", "workshop", { breakSpot: { kind: "plaza", index: k } }),
      ]);
      run(nav, clock, 90_000);
      const bAt = { x: must(nav, "b").x, z: must(nav, "b").z };
      expect(atNode(must(nav, "b"))).toBe(k);
      nav.sync([
        waiting("a", "workshop", { hold: true }),
        waiting("b", "workshop", { breakSpot: { kind: "plaza", index: k } }),
      ]);
      run(nav, clock, 90_000);
      const a = must(nav, "a");
      const b = must(nav, "b");
      // The rule: b is not displaced and a holds a different plaza node.
      expect(dist(b, bAt)).toBeLessThan(1e-6);
      expect(a.state).toBe("stuck");
      expect(atNode(a)).toBeGreaterThanOrEqual(0);
      expect(dist(a, b)).toBeGreaterThan(0.1);
    });

    it(
      "never puts two agents on the same plaza node (seeded sequence)",
      () => {
        const ids = ["a", "b", "c", "d"];
        const { nav, clock } = twoSeated(ids);
        let seed = 20260711;
        const rnd = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 2 ** 32;
        };
        for (let step = 0; step < 40; step++) {
          nav.sync(
            ids.map((id) => {
              const r = rnd();
              if (r < 0.35) return waiting(id, "workshop", { hold: true });
              if (r < 0.8) {
                const index = Math.floor(rnd() * 3);
                return waiting(id, "workshop", { breakSpot: { kind: "plaza", index } });
              }
              return waiting(id, "workshop");
            }),
          );
          run(nav, clock, 60_000);
          const resting = ids.map((id) => must(nav, id)).filter((x) => !isWalking(x));
          for (const x of resting) {
            const k = atNode(x);
            if (k < 0) continue;
            const sharing = resting.filter((y) => y !== x && dist(x, y) < 1e-6);
            expect(sharing.length, `step ${step}: ${x.id} shares plaza node ${k}`).toBe(0);
          }
        }
      },
      FUZZ_TIMEOUT_MS,
    );
  });
});

// roborev 7349: agents with no workstation area walk back from a break to the plaza. They must not
// all return to plaza:center. Rule: each returns to its own free plaza node (not a node held as a
// needs-you safe point, nor one another agent holds or is heading to for a break); if no node is
// free it stays where it is, at its break spot's access. No two resting agents share a position.
describe("area-less agents ending breaks", () => {
  it("return to distinct free plaza nodes, clear of a needs-you safe point", () => {
    const bar = L.breakSites[0];
    const spots = bar?.spots ?? [];
    expect(spots.length).toBeGreaterThanOrEqual(3);
    const ids = ["c1", "c2", "c3"];
    const free = (id: string, extra: Partial<NavIntent> = {}): NavIntent => ({
      id,
      area: null,
      rest: "waiting",
      ...extra,
    });
    const nav = createNavigator();
    const clock = { t: 0 };
    const onBreak = () => [
      free("n", { hold: true }),
      ...ids.map((id, i) =>
        free(id, { breakSpot: { kind: "site", nodeId: (spots[i] as { nodeId: string }).nodeId } }),
      ),
    ];
    nav.sync(onBreak(), { place: true });
    nav.tick(clock.t);
    run(nav, clock, 90_000);
    for (const [i, id] of ids.entries()) {
      expect(dist(must(nav, id), spots[i] as { x: number; z: number })).toBeLessThan(1e-6);
    }

    nav.sync([free("n", { hold: true }), ...ids.map((id) => free(id))]);
    run(nav, clock, 120_000);

    const all = ["n", ...ids].map((id) => must(nav, id));
    for (const a of all) expect(isWalking(a), `${a.id} still walking`).toBe(false);
    for (const x of all) {
      for (const y of all) {
        if (x.id < y.id) {
          expect(dist(x, y), `${x.id} and ${y.id} share a position`).toBeGreaterThan(0.1);
        }
      }
    }
    for (const id of ids) {
      const a = must(nav, id);
      expect(
        plazaNodes.some((n) => dist(n, a) < 1e-6),
        `${id} is on a plaza node`,
      ).toBe(true);
    }
  });
});

// roborev 7351 and the three reviews before it (7314, 7331, 7349) are one bug: plaza nodes were
// claimed through separate mechanisms (the safe-point owner map, break goals, home goals, agents
// standing still) and each chooser checked a different subset. Rule: every chooser (needs-you
// safe point, plaza break, walk home, spawn) honors every claim on a plaza node, and an agent
// denied a node takes it as soon as it frees, in the same sync.
describe("plaza nodes have one reservation source", () => {
  const barSpots = L.breakSites[0]?.spots ?? [];
  const smokeSpots = L.breakSites[1]?.spots ?? [];
  const site = (s: { nodeId: string } | undefined): BreakDestination => {
    if (!s) throw new Error("layout has too few break spots");
    return { kind: "site", nodeId: s.nodeId };
  };
  const loose = (id: string, extra: Partial<NavIntent> = {}): NavIntent => ({
    id,
    area: null,
    rest: "waiting",
    ...extra,
  });
  const atNode = (a: NavAgent) => plazaNodes.findIndex((n) => dist(n, a) < 1e-6);

  it("keeps a needs-you agent off the node an area-less agent walked home to (roborev 7351)", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    const h = (extra: Partial<NavIntent> = {}) =>
      waiting("h", "workshop", { breakSpot: site(barSpots[1]), ...extra });
    nav.sync([loose("r", { breakSpot: site(barSpots[0]) }), h()], { place: true });
    nav.tick(clock.t);
    nav.sync([loose("r"), h()]);
    run(nav, clock, 90_000);
    const home = atNode(must(nav, "r"));
    expect(home, "r walked home to a plaza node").toBeGreaterThanOrEqual(0);

    // r's intent never changes again; h at the bar gets needs-you.
    nav.sync([loose("r"), h({ hold: true })]);
    run(nav, clock, 90_000);
    const r = must(nav, "r");
    const held = must(nav, "h");
    expect(atNode(r)).toBe(home);
    expect(held.state).toBe("stuck");
    expect(atNode(held), "h holds a plaza node").toBeGreaterThanOrEqual(0);
    expect(dist(r, held), "r and h share a plaza node").toBeGreaterThan(0.1);
  });

  it("keeps a needs-you agent off the node an area-less agent stands on", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([loose("s"), waiting("h", "workshop", { breakSpot: site(barSpots[0]) })], {
      place: true,
    });
    nav.tick(clock.t);
    const at = atNode(must(nav, "s"));
    expect(at).toBeGreaterThanOrEqual(0);
    nav.sync([loose("s"), waiting("h", "workshop", { hold: true })]);
    run(nav, clock, 90_000);
    expect(atNode(must(nav, "s"))).toBe(at);
    expect(atNode(must(nav, "h"))).toBeGreaterThanOrEqual(0);
    expect(dist(must(nav, "s"), must(nav, "h"))).toBeGreaterThan(0.1);
  });

  it("resumes a yielded plaza break in the sync that frees its node", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([waiting("a", "workshop"), waiting("b", "workshop")], { place: true });
    nav.tick(clock.t);
    // A seated agent holds at its workstation, so a reaches a plaza safe point from the bar.
    nav.sync([
      waiting("a", "workshop", { breakSpot: site(barSpots[0]) }),
      waiting("b", "workshop"),
    ]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop", { hold: true }), waiting("b", "workshop")]);
    run(nav, clock, 90_000);
    const k = atNode(must(nav, "a"));
    expect(k).toBeGreaterThanOrEqual(0);
    const bIntent = waiting("b", "workshop", { breakSpot: { kind: "plaza", index: k } });
    nav.sync([waiting("a", "workshop", { hold: true }), bIntent]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "b"), slot("workshop:1"))).toBeLessThan(1e-6);

    // One sync: a's hold clears; b's unchanged intent comes first and no further sync comes.
    nav.sync([bIntent, waiting("a", "workshop")]);
    run(nav, clock, 90_000);
    expect(atNode(must(nav, "b"))).toBe(k);
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
  });

  it("walks an area-less agent home once a node frees, when none was free at first", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    const holders = plazaNodes.map((_, i) => `p${i}`);
    nav.sync(
      [
        ...holders.map((id) => loose(id, { hold: true })),
        loose("r", { breakSpot: site(barSpots[0]) }),
      ],
      { place: true },
    );
    nav.tick(clock.t);
    for (const id of holders) expect(atNode(must(nav, id))).toBeGreaterThanOrEqual(0);
    nav.sync([...holders.map((id) => loose(id, { hold: true })), loose("r")]);
    run(nav, clock, 90_000);
    expect(atNode(must(nav, "r")), "no plaza node is free").toBe(-1);

    // p0 leaves the city; r's intent is unchanged and takes the freed node.
    const freed = atNode(must(nav, "p0"));
    nav.sync([...holders.slice(1).map((id) => loose(id, { hold: true })), loose("r")]);
    run(nav, clock, 90_000);
    nav.prune();
    expect(atNode(must(nav, "r"))).toBe(freed);
    expect(isWalking(must(nav, "r"))).toBe(false);
  });

  it("stops a needs-you walker short of a held plaza node when every node is held", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    const holders = plazaNodes.map((_, i) => `p${i}`);
    const held = holders.map((id) => loose(id, { hold: true }));
    nav.sync(held, { place: true });
    nav.tick(clock.t);
    // A newcomer starts beside the full plaza and walks through it; needs-you arrives mid-walk.
    nav.sync([...held, waiting("w", "workshop")]);
    run(nav, clock, 300);
    nav.sync([...held, waiting("w", "workshop", { hold: true })]);
    run(nav, clock, 30_000);
    const w = must(nav, "w");
    expect(w.state).toBe("stuck");
    for (const id of holders) {
      expect(dist(w, must(nav, id)), `w stands on ${id}'s node`).toBeGreaterThan(0.1);
    }
  });

  /**
   * Seeded random runs mixing needs-you holds, plaza breaks, site breaks, area-less agents, area
   * changes and removals. Five agents never need more than the five plaza nodes, so every agent
   * must also reach a legal resting place by the end of each step.
   */
  // The last two seeds (found by a wider search, M9.09 review) use short steps, so intents change
  // while agents are still walking: a needs-you agent whose goal is home or a break spot is reached
  // mid-walk with every plaza node held, and must not stop on a node another agent holds. Only the
  // no-sharing check applies to those runs (they do not wait for everyone to settle).
  const runs = [
    ...[7351, 20261107, 424242].map((seed) => ({ seed, short: false })),
    ...[3590, 44475].map((seed) => ({ seed, short: true })),
  ];
  for (const { seed: seed0, short } of runs) {
    it(
      `never stacks resting agents on a plaza node${short ? " mid-walk" : " and settles everyone"} (seed ${seed0})`,
      () => {
        let seed = seed0;
        const rnd = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 2 ** 32;
        };
        const areas = ["workshop", "archives", "dispatch"] as const;
        const ids = ["a0", "a1", "a2", "a3", "a4"];
        const arealess = new Set(["a0", "a1"]);
        const siteOf: Record<string, BreakDestination> = {
          a0: site(barSpots[0]),
          a1: site(barSpots[1]),
          a2: site(barSpots[2]),
          a3: site(barSpots[3]),
          a4: site(smokeSpots[0]),
        };
        const areaOf: Record<string, NavIntent["area"]> = {
          a0: null,
          a1: null,
          a2: "workshop",
          a3: "workshop",
          a4: "archives",
        };
        const intentFor = (id: string): NavIntent | null => {
          const r = rnd();
          if (r < 0.06) return null;
          if (!arealess.has(id) && rnd() < 0.2) {
            areaOf[id] = areas[Math.floor(rnd() * areas.length)] as NavIntent["area"];
          }
          const base = { id, area: areaOf[id] ?? null, rest: "waiting" as const };
          if (r < 0.3) return { ...base, hold: true };
          if (r < 0.5) {
            return {
              ...base,
              breakSpot: { kind: "plaza", index: Math.floor(rnd() * plazaNodes.length) },
            };
          }
          if (r < 0.78) return { ...base, breakSpot: siteOf[id] as BreakDestination };
          return base;
        };
        const nav = createNavigator();
        const clock = { t: 0 };
        nav.sync(
          ids.map((id) => ({ id, area: areaOf[id] ?? null, rest: "waiting" as const })),
          { place: true },
        );
        nav.tick(clock.t);
        const siteNodes = [...barSpots, ...smokeSpots];
        const noSharing = (label: string) => {
          const resting = nav.list().filter((x) => !x.gone && !isWalking(x));
          for (const x of resting) {
            const k = atNode(x);
            if (k < 0) continue;
            const other = resting.find((y) => y !== x && dist(x, y) < 1e-6);
            expect(
              other,
              `${label}: ${x.id} and ${other?.id} share plaza node ${k}`,
            ).toBeUndefined();
          }
        };
        for (let step = 0; step < (short ? 80 : 50); step++) {
          const intents = ids.map(intentFor).filter((x): x is NavIntent => x !== null);
          nav.sync(intents);
          noSharing(`step ${step} sync`);
          run(nav, clock, short && rnd() >= 0.15 ? Math.floor(rnd() * 1800) : 90_000, () =>
            noSharing(`step ${step} t=${clock.t}`),
          );
          nav.prune();
          for (const intent of short ? [] : intents) {
            const a = must(nav, intent.id);
            const label = `step ${step}: ${a.id} ${JSON.stringify(intent)} at (${a.x.toFixed(2)}, ${a.z.toFixed(2)})`;
            expect(isWalking(a), `${label} still walking`).toBe(false);
            const ownSlot = a.slotId !== null && dist(a, slot(a.slotId)) < 1e-6;
            const onPlaza = atNode(a) >= 0;
            const onSite = siteNodes.find((s) => dist(s, a) < 1e-6);
            const legal =
              ownSlot ||
              a.queued ||
              onPlaza ||
              (onSite !== undefined &&
                intent.breakSpot?.kind === "site" &&
                intent.breakSpot.nodeId === onSite.nodeId);
            expect(legal, `${label} is not at a legal resting place`).toBe(true);
            if (intent.hold) {
              expect(a.state, label).toBe("stuck");
              expect(ownSlot || a.queued || onPlaza, `${label} holds off the plaza`).toBe(true);
            } else if (intent.area === null && intent.breakSpot?.kind !== "site") {
              expect(onPlaza, `${label} area-less and not home`).toBe(true);
            } else if (intent.area !== null && intent.breakSpot === undefined) {
              expect(ownSlot || a.queued, `${label} not at work`).toBe(true);
            }
          }
        }
      },
      FUZZ_TIMEOUT_MS,
    );
  }
});

// M9.09 (M9.08 debugger residual): an agent standing exactly on a plaza node that another agent
// has just been given (it left a plaza break there), when needs-you arrives with every plaza node
// held, kept standing on it, so two agents shared the node. Rule: it must not stay on a node held
// by another agent; with no free plaza node it still stops as stuck, but clear of every other
// agent (it may step aside or carry on to its workstation, the test only forbids sharing).
describe("a needs-you agent standing on a node that is now held by another agent (M9.09)", () => {
  const loose = (id: string, extra: Partial<NavIntent> = {}): NavIntent => ({
    id,
    area: null,
    rest: "waiting",
    ...extra,
  });
  const atNode = (a: NavAgent) => plazaNodes.findIndex((n) => dist(n, a) < 1e-6);

  it.each(plazaNodes.map((_, k) => k))(
    "does not share plaza node %i when every node is held",
    (k) => {
      const nav = createNavigator();
      const clock = { t: 0 };
      const holders = plazaNodes.map((_, i) => i).filter((i) => i !== k);
      const held = () => holders.map((i) => loose(`h${i}`, { hold: true }));
      const w = (extra: Partial<NavIntent> = {}) =>
        waiting("w", "workshop", { breakSpot: { kind: "plaza", index: k }, ...extra });
      nav.sync([w(), ...held()], { place: true });
      nav.tick(clock.t);
      run(nav, clock, 150_000);
      expect(atNode(must(nav, "w")), "w stands on its plaza break node").toBe(k);
      for (const i of holders) expect(atNode(must(nav, `h${i}`))).toBeGreaterThanOrEqual(0);

      // w's break ends, so its node frees and p, which needs you and has no node, is given it.
      // Needs-you then reaches w in the next sync, before w has taken a step.
      const noBreak = (extra: Partial<NavIntent> = {}) => waiting("w", "workshop", extra);
      nav.sync([loose("p", { hold: true }), noBreak(), ...held()]);
      nav.sync([loose("p", { hold: true }), noBreak({ hold: true }), ...held()]);
      run(nav, clock, 150_000);

      const ids = ["w", "p", ...holders.map((i) => `h${i}`)];
      for (const x of ids) {
        for (const y of ids) {
          if (x >= y) continue;
          expect(
            dist(must(nav, x), must(nav, y)),
            `${x} and ${y} share a spot (w ${atNode(must(nav, "w"))}, p ${atNode(must(nav, "p"))})`,
          ).toBeGreaterThan(0.1);
        }
      }
    },
  );
});
