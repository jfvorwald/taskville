import { type Object3D, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { message, stored } from "./envelopeFixtures.ts";
import { ENVELOPE_FLIGHT_MS } from "./envelopes.ts";
import { FRAME_WAIT, type MountOptions, mount } from "./testScene.tsx";

// M5.04 red: the envelope in a real scene, with real pointer events. A message event makes one
// paper envelope fly from the sender to the recipient; hovering shows who wrote to whom;
// clicking selects the sender and asks for the message in its feed (ARCHITECTURE 2.9).

const tooltip = () => document.querySelector('[role="tooltip"]');

async function inFlight(options: MountOptions = {}) {
  const scene = await mount(options);
  const event = message("pip", "bo", "hi bo");
  scene.store.getState().applyEvent(event);
  scene.clock.now = ENVELOPE_FLIGHT_MS / 2;
  await vi.waitFor(() => expect(scene.envelopes()).toHaveLength(1), FRAME_WAIT);
  await scene.frames(3);
  return { scene, event };
}

describe("teammate message envelopes in the city", () => {
  it("flies one envelope per message event and none for other events", async () => {
    const scene = await mount();
    try {
      const first = message("pip", "bo");
      const reply = message("bo", "pip");
      scene.store.getState().applyEvent(first);
      scene.store.getState().applyEvent(stored("activity.started", "pip", { activity: "idle" }));
      scene.store.getState().applyEvent(reply);
      await vi.waitFor(() => expect(scene.envelopes()).toHaveLength(2), FRAME_WAIT);
      expect(scene.envelopes().map((o) => o.userData.envelopeId)).toEqual([
        first.eventId,
        reply.eventId,
      ]);
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("moves the envelope from the sender toward the recipient and then removes it", async () => {
    const scene = await mount();
    try {
      scene.store.getState().applyEvent(message("pip", "bo"));
      await vi.waitFor(() => expect(scene.envelopes()).toHaveLength(1), FRAME_WAIT);
      const at = (ms: number) => {
        scene.clock.now = ms;
        return scene.frames(2).then(() => scene.envelopes()[0]?.getWorldPosition(new Vector3()).x);
      };
      const early = (await at(ENVELOPE_FLIGHT_MS * 0.1)) as number;
      const late = (await at(ENVELOPE_FLIGHT_MS * 0.9)) as number;
      expect(early).toBeLessThan(0);
      expect(late).toBeGreaterThan(0);
      scene.clock.now = ENVELOPE_FLIGHT_MS + 1;
      await vi.waitFor(() => expect(scene.envelopes()).toHaveLength(0), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("shows who wrote to whom while the pointer is over the envelope", async () => {
    const { scene } = await inFlight();
    try {
      const canvas = scene.root().gl.domElement;
      const envelope = scene.envelopes()[0];
      expect(tooltip()).toBeNull();
      await userEvent.hover(canvas, { position: scene.onCanvas(envelope as Object3D) });
      await vi.waitFor(() => expect(tooltip()?.textContent).toBe("Pip to Bo: hi bo"), FRAME_WAIT);
      await userEvent.hover(canvas, { position: { x: 4, y: 4 } });
      await vi.waitFor(() => expect(tooltip()).toBeNull(), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("selects the sender and asks for the message in its feed on a real click", async () => {
    const { scene, event } = await inFlight();
    try {
      scene.selection.select("bo");
      await userEvent.click(scene.root().gl.domElement, {
        position: scene.onCanvas(scene.envelopes()[0] as Object3D),
      });
      await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBe("pip"), FRAME_WAIT);
      expect(scene.feedFocus.getSnapshot()).toEqual({ agentId: "pip", eventId: event.eventId });
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("cannot be hovered or clicked from behind an opaque building", async () => {
    const { scene } = await inFlight({ occluder: true });
    try {
      const canvas = scene.root().gl.domElement;
      const at = scene.onCanvas(scene.envelopes()[0] as Object3D);
      scene.selection.select("bo");
      await userEvent.hover(canvas, { position: at });
      await scene.frames(3);
      expect(tooltip()).toBeNull();

      await userEvent.click(canvas, { position: at });
      await scene.frames(3);
      expect(scene.selection.getSnapshot()).not.toBe("pip");
      expect(scene.feedFocus.getSnapshot()).toBeNull();
    } finally {
      await scene.unmount();
    }
  }, 60_000);
});
