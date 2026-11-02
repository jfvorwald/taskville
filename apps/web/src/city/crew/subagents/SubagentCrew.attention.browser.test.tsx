import type { Object3D, Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { colorMaterial } from "../../agents/resources.ts";
import { CITY_LAYOUT } from "../../layout/index.ts";
import { crewMarkerLabel } from "./crew.ts";
import { pillMaterial } from "./resources.ts";
import {
  FRAME_WAIT,
  flatDistance,
  LEAD,
  mount,
  partsOf,
  type Scene,
  sub,
  T,
  WORKING_MS,
} from "./testScene.tsx";
import { TINT_HEX } from "./tint.ts";

// M5.02 round 5 (code review BLOCKED): "needs you" must reach every subagent of a family, however
// it is drawn (ARCHITECTURE 2.9: "a permission request from a subagent turns that subagent red,
// and its parent gets a small red dot so the family is easy to find").
//
// Contract the implementer must add, because a dot has no pooled material to compare:
//  - the red dot is a scene object with `userData.needsYouDot = <id of the agent that wears it>`,
//    visible (it and every group above it) exactly while a descendant of that agent needs you;
//  - the wearer is the nearest DRAWN ancestor (a bot that is shown, or the block agent whose
//    anchor the crew layer follows), and the dot stands within DOT_REACH of that agent.
// Everything else is observed through existing exports: `pillMaterial`, `colorMaterial`, the
// bot's `userData.agentId`.

const DOT_REACH = 1.2;
const T_RED = TINT_HEX.red;

const MARKER_LABEL = crewMarkerLabel(1);
const markerMaterials = [
  pillMaterial(MARKER_LABEL),
  pillMaterial(MARKER_LABEL, TINT_HEX.red),
  pillMaterial(MARKER_LABEL, TINT_HEX.amber),
];
const markerOf = (scene: Scene): Sprite | undefined => scene.spritesOf(markerMaterials)[0];
/** Which pill the marker wears, as a word, so a failure reads "expected plain to be red". */
const markerLook = (scene: Scene): string => {
  const material = markerOf(scene)?.material;
  if (material === undefined) return "none";
  if (material === markerMaterials[0]) return "plain";
  return material === markerMaterials[1] ? "red" : "amber";
};

const work = async (scene: Scene, id: string) => {
  await scene.frames(2);
  scene.clock.now = WORKING_MS;
  await vi.waitFor(() => expect(scene.shown(id)).toBe(true), FRAME_WAIT);
};

describe("a red dot on the parent of a subagent that needs you", () => {
  it("puts a dot on the block agent whose subagent needs you, and clears it when nothing does", async () => {
    const family = [LEAD, sub("s1", "lead"), sub("s2", "lead")];
    const scene = await mount(family, { needsYou: ["s2"] });
    try {
      await work(scene, "s2");
      await vi.waitFor(() => expect(scene.dotsOn("lead").length).toBeGreaterThan(0), FRAME_WAIT);
      // Near the lead (its anchor is at x 2, z 3), not on a subagent.
      const dot = scene.dotsOn("lead")[0];
      expect(flatDistance(scene.at(dot as Object3D), { x: 2, z: 3 })).toBeLessThan(DOT_REACH);
      expect(scene.dotsOn("s1")).toHaveLength(0);
      expect(scene.dotsOn("s2")).toHaveLength(0);

      // The request is answered: no descendant needs you, so the dot goes.
      scene.set(family, []);
      await vi.waitFor(() => expect(scene.dotsOn("lead")).toHaveLength(0), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("shows no dot while no subagent needs you", async () => {
    const scene = await mount([LEAD, sub("s1", "lead")]);
    try {
      await work(scene, "s1");
      await scene.frames(3);
      expect(scene.dotsOn("lead")).toHaveLength(0);
      expect(scene.dotsOn("s1")).toHaveLength(0);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("puts the dot on the parent bot of a nested subagent that needs you", async () => {
    const family = [LEAD, sub("s1", "lead"), sub("kid", "s1")];
    const scene = await mount(family, { needsYou: ["kid"] });
    try {
      await work(scene, "kid");
      await vi.waitFor(() => expect(scene.dotsOn("s1").length).toBeGreaterThan(0), FRAME_WAIT);
      const parent = scene.bot("s1");
      const dot = scene.dotsOn("s1")[0];
      expect(flatDistance(scene.at(dot as Object3D), scene.at(parent as Object3D))).toBeLessThan(
        DOT_REACH,
      );

      scene.set(family, []);
      await vi.waitFor(() => expect(scene.dotsOn("s1")).toHaveLength(0), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("puts the dot on the deepest drawn bot for a subagent too deep for a bot of its own", async () => {
    // lead > a (1) > b (2) > c (3, no bot): c needs you, b is the nearest drawn ancestor.
    const scene = await mount([LEAD, sub("a", "lead"), sub("b", "a"), sub("c", "b")], {
      needsYou: ["c"],
    });
    try {
      await work(scene, "b");
      await vi.waitFor(() => expect(scene.dotsOn("b").length).toBeGreaterThan(0), FRAME_WAIT);
      expect(scene.dotsOn("a")).toHaveLength(0);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("puts the dot on the nearest drawn ancestor when the subagent that needs you is behind a +N marker", async () => {
    // s4 is behind the lead's marker, so its child c4 is out of sight too: the lead wears the dot.
    const scene = await mount(
      [
        LEAD,
        sub("s1", "lead"),
        sub("s2", "lead"),
        sub("s3", "lead"),
        sub("s4", "lead"),
        sub("c4", "s4"),
      ],
      { needsYou: ["c4"] },
    );
    try {
      await work(scene, "s3");
      await vi.waitFor(() => expect(scene.dotsOn("lead").length).toBeGreaterThan(0), FRAME_WAIT);
      expect(scene.shown("c4")).toBe(false);
      expect(scene.dotsOn("s4")).toHaveLength(0);
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});

describe("the N deeper pill and a deep subagent that needs you", () => {
  const chain = [LEAD, sub("a", "lead"), sub("b", "a"), sub("c", "b")];

  it("takes the red of a generation 3 subagent it counts, and is plain otherwise", async () => {
    const scene = await mount(chain);
    try {
      await work(scene, "b");
      const plain = pillMaterial("1 deeper");
      await vi.waitFor(() => expect(scene.spritesOf([plain])).toHaveLength(1), FRAME_WAIT);

      scene.set(chain, ["c"]);
      const red = pillMaterial("1 deeper", T_RED);
      await vi.waitFor(() => expect(scene.spritesOf([red])).toHaveLength(1), FRAME_WAIT);
      expect(scene.spritesOf([plain])).toHaveLength(0);

      scene.set(chain, []);
      await vi.waitFor(() => expect(scene.spritesOf([plain])).toHaveLength(1), FRAME_WAIT);
      expect(scene.spritesOf([red])).toHaveLength(0);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("takes the red of a generation 4 subagent it counts", async () => {
    const scene = await mount([...chain, sub("d", "c")], { needsYou: ["d"] });
    try {
      await work(scene, "b");
      await vi.waitFor(
        () => expect(scene.spritesOf([pillMaterial("2 deeper", T_RED)])).toHaveLength(1),
        FRAME_WAIT,
      );
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("takes the amber of a deep subagent in trouble", async () => {
    const scene = await mount([
      LEAD,
      sub("a", "lead"),
      sub("b", "a"),
      sub("c", "b", { consecutiveToolFailures: 3 }),
    ]);
    try {
      await work(scene, "b");
      await vi.waitFor(
        () => expect(scene.spritesOf([pillMaterial("1 deeper", TINT_HEX.amber)])).toHaveLength(1),
        FRAME_WAIT,
      );
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});

describe("the +N crew marker and the descendants of the subagents behind it", () => {
  const FOUR = [LEAD, sub("s1", "lead"), sub("s2", "lead"), sub("s3", "lead"), sub("s4", "lead")];

  it("is plain while nothing behind it needs you", async () => {
    const scene = await mount([...FOUR, sub("c4", "s4")]);
    try {
      await work(scene, "s3");
      await vi.waitFor(
        () => expect(scene.spritesOf([pillMaterial(MARKER_LABEL)])).toHaveLength(1),
        FRAME_WAIT,
      );
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("takes the red of a child of a hidden member that needs you", async () => {
    const scene = await mount([...FOUR, sub("c4", "s4")], { needsYou: ["c4"] });
    try {
      await work(scene, "s3");
      await vi.waitFor(() => expect(markerLook(scene)).toBe("red"), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("takes the red of a deeper descendant of a hidden member that needs you", async () => {
    // s4 > c4 > g4 (generation 3): g4 is only a count on c4's family, and it still needs you.
    const scene = await mount([...FOUR, sub("c4", "s4"), sub("g4", "c4")], {
      needsYou: ["g4"],
    });
    try {
      await work(scene, "s3");
      await vi.waitFor(() => expect(markerLook(scene)).toBe("red"), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("takes the amber of a child of a hidden member in trouble", async () => {
    const scene = await mount([...FOUR, sub("c4", "s4", { consecutiveToolFailures: 3 })]);
    try {
      await work(scene, "s3");
      await vi.waitFor(() => expect(markerLook(scene)).toBe("amber"), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});

describe("a running subagent whose family was never placed", () => {
  it("is drawn at the plaza center when nothing above it is drawn, selectable and red when it needs you", async () => {
    // After a reload: the lead has no anchor yet and nothing was ever placed.
    const scene = await mount([LEAD, sub("kid", "lead")], { anchor: null, needsYou: ["kid"] });
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("kid")).toBe(true), FRAME_WAIT);

      const kid = scene.bot("kid");
      expect(kid?.userData.agentId).toBe("kid");
      const plaza = { x: CITY_LAYOUT.plaza.cx, z: CITY_LAYOUT.plaza.cz };
      expect(flatDistance(scene.at(kid as Object3D), plaza)).toBeLessThan(2);

      const { body, trim } = partsOf(kid as Object3D);
      await vi.waitFor(() => expect(body.material).toBe(colorMaterial(TINT_HEX.red)), FRAME_WAIT);
      expect(trim.material).toBe(colorMaterial(TINT_HEX.red));
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("is drawn at the nearest drawn ancestor when its own parent was never seen running", async () => {
    // lead (anchored at x 2, z 3) > s1 (already finished when the page loaded: no bot, no place)
    // > kid (running). The family of s1 has no place; the lead is the nearest drawn ancestor.
    const scene = await mount([LEAD, sub("s1", "lead", { finishedAt: T }), sub("kid", "s1")]);
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("kid")).toBe(true), FRAME_WAIT);
      expect(scene.bot("kid")?.userData.agentId).toBe("kid");
      expect(flatDistance(scene.at(scene.bot("kid") as Object3D), { x: 2, z: 3 })).toBeLessThan(2);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("is still drawn after the lead's anchor goes and the page was reloaded around it", async () => {
    // The subagent arrives in the store after the lead already lost its anchor.
    const scene = await mount([LEAD], { anchor: null });
    try {
      await scene.frames(2);
      scene.set([LEAD, sub("late", "lead")]);
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("late")).toBe(true), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});
