import { expect, it, vi } from "vitest";
import { FADE_MS, HAND_OVER_MS, RETURN_MS } from "./lifecycle.ts";
import { pillMaterial } from "./resources.ts";
import { LEAD, mount, sub, T, WORKING_MS } from "./testScene.tsx";

it("hides the waiting emote after its parent fades while keeping the running child visible", async () => {
  const parent = sub("parent", "lead");
  const child = sub("child", "parent");
  const scene = await mount([LEAD, parent, child]);
  try {
    await scene.frames(3);
    scene.clock.now = WORKING_MS;
    await scene.frames(5);
    expect(scene.spritesOf([pillMaterial("... crew")])).toHaveLength(2);
    scene.set([LEAD, { ...parent, finishedAt: T }, child]);
    await scene.frames(5);
    expect(scene.spritesOf([pillMaterial("... crew")])).toHaveLength(1);
    scene.clock.now += RETURN_MS + HAND_OVER_MS + FADE_MS + 1;
    await scene.frames(8);
    await vi.waitFor(() => expect(scene.bot("parent")).toBeUndefined());
    expect(scene.shown("child")).toBe(true);
    expect(scene.spritesOf([pillMaterial("... crew")])).toHaveLength(0);
  } finally {
    await scene.unmount();
  }
});

it("unmounts faded crew and stops its clock work without another store event", async () => {
  let reads = 0;
  const scene = await mount([LEAD, sub("kid", "lead")], {
    onNow: () => {
      reads++;
    },
  });
  try {
    await scene.frames(3);
    scene.clock.now = WORKING_MS;
    await scene.frames(3);
    expect(scene.shown("kid")).toBe(true);
    scene.set([LEAD, sub("kid", "lead", { finishedAt: T })]);
    await scene.frames(3);
    scene.clock.now += RETURN_MS + HAND_OVER_MS + FADE_MS + 1;
    await scene.frames(8);
    expect(scene.shown("kid")).toBe(false);
    await vi.waitFor(() =>
      expect(scene.find((object) => object.userData.agentId === "kid")).toHaveLength(0),
    );
    const settled = reads;
    await scene.frames(8);
    expect(reads).toBe(settled);
    expect(scene.store.getState().agents).toHaveLength(2);
  } finally {
    await scene.unmount();
  }
});
