import type { Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AT, stored } from "./envelopeFixtures.ts";
import { ENVELOPE_FLIGHT_MS } from "./envelopes.ts";
import { FRAME_WAIT, mount } from "./testScene.tsx";

// M5.28 (decision #556): a clicked envelope hands the message's SendMessage tool-call id to the
// feed hand-off, so the Live feed can focus that exact card. No id on the event, no id in the request.

async function click(payload: Record<string, unknown>) {
  const scene = await mount();
  const event = stored("team.message", "pip", { to: "bo", kind: "message", ...payload }, AT);
  scene.store.getState().applyEvent(event);
  scene.clock.now = ENVELOPE_FLIGHT_MS / 2;
  await vi.waitFor(() => expect(scene.envelopes()).toHaveLength(1), FRAME_WAIT);
  await scene.frames(3);
  await userEvent.click(scene.root().gl.domElement, {
    position: scene.onCanvas(scene.envelopes()[0] as Object3D),
  });
  await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBe("pip"), FRAME_WAIT);
  return { scene, event };
}

describe("a clicked envelope and the SendMessage tool-call id", () => {
  it("requests the sender's feed with the event's toolCallId", async () => {
    const { scene, event } = await click({ toolCallId: "toolu_01SendA" });
    try {
      expect(scene.feedFocus.getSnapshot()).toEqual({
        agentId: "pip",
        eventId: event.eventId,
        toolCallId: "toolu_01SendA",
      });
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("requests without a toolCallId when the event has none", async () => {
    const { scene, event } = await click({});
    try {
      expect(scene.feedFocus.getSnapshot()).toEqual({ agentId: "pip", eventId: event.eventId });
    } finally {
      await scene.unmount();
    }
  }, 60_000);
});
