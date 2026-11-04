import type { MeshStandardMaterial, Object3D, Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { colorMaterial } from "../../agents/resources.ts";
import { emoteMaterial } from "../../attention/resources.ts";
import { FADE_MS, HAND_OVER_MS, RETURN_MS } from "./lifecycle.ts";
import { pillMaterial } from "./resources.ts";
import { doorRadius, workSpot } from "./spots.ts";
import {
  FRAME_WAIT,
  flatDistance,
  isShown,
  LEAD,
  mount,
  partsOf,
  type Scene,
  sub,
  T,
  WORKING_MS,
} from "./testScene.tsx";
import { TINT_HEX } from "./tint.ts";

// M5.02 round 5: the crew layer's rules that had no test, plus the distinct look of the parent's
// "waiting on its crew" sprite (ARCHITECTURE 2.9: "a '...' emote, which looks different from
// waiting on you").

/** The sprites of one family that are drawn right now: with no marker, no count and no dot in
 * play, that is the parent's "waiting on crew" sprite and nothing else. */
const drawnSprites = (family: Object3D): Sprite[] =>
  family.children.filter((c): c is Sprite => (c as Sprite).isSprite === true && isShown(c));

const familyOf = (scene: Scene, id: string): Object3D => {
  const parent = scene.bot(id)?.parent;
  if (parent === null || parent === undefined) throw new Error(`no family for ${id}`);
  return parent;
};

describe("the parent's sprite while it waits for its crew", () => {
  it("is drawn while a subagent walks out and while it works, and not once it has finished", async () => {
    const family = [LEAD, sub("s1", "lead")];
    const scene = await mount(family);
    try {
      await scene.frames(2);
      scene.clock.now = 1000; // walking out
      await vi.waitFor(() => expect(scene.shown("s1")).toBe(true), FRAME_WAIT);
      await vi.waitFor(
        () => expect(drawnSprites(familyOf(scene, "s1"))).toHaveLength(1),
        FRAME_WAIT,
      );

      scene.clock.now = WORKING_MS; // working
      await scene.frames(3);
      expect(drawnSprites(familyOf(scene, "s1"))).toHaveLength(1);

      // The subagent finishes and walks home: the parent is not waiting any more.
      scene.set([LEAD, sub("s1", "lead", { finishedAt: T })]);
      await scene.frames(3);
      scene.clock.now = WORKING_MS + 1000;
      await vi.waitFor(
        () => expect(drawnSprites(familyOf(scene, "s1"))).toHaveLength(0),
        FRAME_WAIT,
      );
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("is not the attention '...' or 'zzz' emote, so it never reads as waiting on you", async () => {
    const scene = await mount([LEAD, sub("s1", "lead")]);
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(
        () => expect(drawnSprites(familyOf(scene, "s1"))).toHaveLength(1),
        FRAME_WAIT,
      );
      const wait = drawnSprites(familyOf(scene, "s1"))[0] as Sprite;
      for (const attention of ["...", "zzz"] as const) {
        const emote = emoteMaterial(attention);
        // A different material, and not the same picture in a new material either.
        expect(wait.material === emote, `material is the "${attention}" emote`).toBe(false);
        expect(wait.material.map === emote.map, `texture is the "${attention}" emote`).toBe(false);
      }
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});

describe("reduced motion", () => {
  it("puts a walking bot at its spot at once, with no hop", async () => {
    const scene = await mount([LEAD, sub("s1", "lead")], { reducedMotion: true });
    try {
      await scene.frames(2);
      scene.clock.now = 1000; // 40% through the walk out
      await vi.waitFor(() => expect(scene.shown("s1")).toBe(true), FRAME_WAIT);
      await scene.frames(3);
      const spot = workSpot(0, 1);
      const p = scene.bot("s1")?.position;
      expect(p?.y).toBe(0);
      expect(p?.x).toBeCloseTo(Math.sin(spot.angle) * spot.radius, 5);
      expect(p?.z).toBeCloseTo(Math.cos(spot.angle) * spot.radius, 5);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("puts a returning bot at the door at once, and does not fade it", async () => {
    const scene = await mount([LEAD, sub("s1", "lead")], { reducedMotion: true });
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("s1")).toBe(true), FRAME_WAIT);
      scene.set([LEAD, sub("s1", "lead", { finishedAt: T })]);
      await scene.frames(3);

      scene.clock.now = WORKING_MS + 1000; // 40% of the way home
      await scene.frames(3);
      const spot = workSpot(0, 1);
      const door = doorRadius(1);
      const at = scene.bot("s1")?.position;
      expect(at?.y).toBe(0);
      expect(at?.x).toBeCloseTo(Math.sin(spot.angle) * door, 5);
      expect(at?.z).toBeCloseTo(Math.cos(spot.angle) * door, 5);

      // Half way through the fade it is still solid, then it is gone.
      scene.clock.now = WORKING_MS + RETURN_MS + HAND_OVER_MS + FADE_MS / 2;
      await scene.frames(3);
      expect(scene.shown("s1")).toBe(true);
      const { body } = partsOf(scene.bot("s1") as Object3D);
      expect((body.material as MeshStandardMaterial).transparent).toBe(false);

      scene.clock.now = WORKING_MS + RETURN_MS + HAND_OVER_MS + FADE_MS + 100;
      await vi.waitFor(() => expect(scene.shown("s1")).toBe(false), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});

describe("the N deeper pill", () => {
  it("counts the running subagents too deep for a bot, on the generation 2 bot that owns them", async () => {
    // lead > a1 > b1 > c1                (one deep, owned by b1)
    // lead > a2 > b2 > c2 > d2           (two deep, owned by b2)
    const agents = [
      LEAD,
      sub("a1", "lead"),
      sub("b1", "a1"),
      sub("c1", "b1"),
      sub("a2", "lead"),
      sub("b2", "a2"),
      sub("c2", "b2"),
      sub("d2", "c2"),
    ];
    const scene = await mount(agents);
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("b1")).toBe(true), FRAME_WAIT);
      await vi.waitFor(() => expect(scene.shown("b2")).toBe(true), FRAME_WAIT);

      const one = pillMaterial("1 deeper");
      const two = pillMaterial("2 deeper");
      await vi.waitFor(() => expect(scene.spritesOf([one])).toHaveLength(1), FRAME_WAIT);
      expect(scene.spritesOf([two])).toHaveLength(1);
      // Each count stands by its own owner.
      const near = (pill: Sprite, owner: string) =>
        flatDistance(scene.at(pill), scene.at(scene.bot(owner) as Object3D));
      expect(near(scene.spritesOf([one])[0] as Sprite, "b1")).toBeLessThan(1);
      expect(near(scene.spritesOf([two])[0] as Sprite, "b2")).toBeLessThan(1);
      // None of the deep subagents has a bot of its own.
      for (const id of ["c1", "c2", "d2"]) expect(scene.bot(id), id).toBeUndefined();
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});

describe("a crew bot that needs you or is in trouble", () => {
  it("wears red or amber on its body and trim, and keeps its own colors otherwise", async () => {
    const scene = await mount(
      [
        LEAD,
        sub("red", "lead"),
        sub("amber", "lead", { consecutiveToolFailures: 3 }),
        sub("plain", "lead"),
      ],
      { needsYou: ["red"] },
    );
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      for (const id of ["red", "amber", "plain"]) {
        await vi.waitFor(() => expect(scene.shown(id), id).toBe(true), FRAME_WAIT);
      }
      const red = colorMaterial(TINT_HEX.red);
      const amber = colorMaterial(TINT_HEX.amber);
      await vi.waitFor(
        () => expect(partsOf(scene.bot("red") as Object3D).body.material).toBe(red),
        FRAME_WAIT,
      );
      expect(partsOf(scene.bot("red") as Object3D).trim.material).toBe(red);
      await vi.waitFor(
        () => expect(partsOf(scene.bot("amber") as Object3D).body.material).toBe(amber),
        FRAME_WAIT,
      );
      expect(partsOf(scene.bot("amber") as Object3D).trim.material).toBe(amber);
      const plain = partsOf(scene.bot("plain") as Object3D);
      for (const m of [plain.body.material, plain.trim.material]) {
        expect(m === red || m === amber).toBe(false);
      }
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});

describe("unmounting the crew layer", () => {
  it("stops its frame work, drops its store subscription and leaves nothing in the scene", async () => {
    let subscribed = 0;
    let nowCalls = 0;
    let anchorCalls = 0;
    const scene = await mount([LEAD, sub("s1", "lead")], {
      onNow: () => {
        nowCalls++;
      },
      onGetAnchor: () => {
        anchorCalls++;
      },
      wrapStore: (store) => {
        const subscribe = store.subscribe;
        store.subscribe = (listener) => {
          subscribed++;
          const off = subscribe(listener);
          return () => {
            subscribed--;
            off();
          };
        };
      },
    });
    try {
      await scene.frames(3);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("s1")).toBe(true), FRAME_WAIT);
      // The layer is alive: it subscribed, and every frame reads the clock and the anchor.
      expect(subscribed).toBeGreaterThan(0);
      const before = { now: nowCalls, anchor: anchorCalls };
      await scene.frames(3);
      expect(nowCalls).toBeGreaterThan(before.now);
      expect(anchorCalls).toBeGreaterThan(before.anchor);

      await scene.removeLayer();
      await vi.waitFor(() => expect(scene.bot("s1")).toBeUndefined(), FRAME_WAIT);
      expect(subscribed).toBe(0);
      // The canvas keeps drawing, and the layer does no more work for it.
      await scene.frames(2);
      const after = { now: nowCalls, anchor: anchorCalls };
      await scene.frames(5);
      expect(nowCalls).toBe(after.now);
      expect(anchorCalls).toBe(after.anchor);
      expect(scene.find((o) => o.userData.agentId !== undefined)).toHaveLength(0);
      expect(scene.find((o) => (o as Sprite).isSprite === true)).toHaveLength(0);
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});
