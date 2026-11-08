import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../test/data/fake-engine.ts";
import { createDataStore } from "../../data/store.ts";
import {
  PresentedSidebar,
  presentedAgentPanelOverlay,
} from "../../history/ui/PresentedSidebar.tsx";
import { Bubbles } from "../../overlays/bubbles/Bubbles.tsx";
import type { OverlayProps } from "../../overlays/host/types.ts";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { pickBanterLine } from "../../quips/index.ts";
import { themeController } from "../../themes/core/index.ts";
import { lightingController } from "../lighting/instance.ts";
import {
  breakPoint,
  dist,
  expectedPlan,
  type Harness,
  mountCity,
  overlayProps,
  SECOND,
  stateOf,
  WAITING_SINCE,
} from "./harness.fixture.tsx";
import type { AgentBreak, Conversation } from "./types.ts";

// M9.08: chatter, the Break time switch, the agent panel and history placement, wired to the city.
// Same setup as BreakTime.browser.test.tsx: pinned data-store clock, reduced motion except where
// noted, always-day lighting. The pair of agents is found with the pure planner so the test does
// not depend on luck: two agents on break at one place with a conversation that spans two turns.
// Run: pnpm test:browser src/city/breaks/BreakTime.chatter  (from apps/web)

// A poll returns as soon as it holds, so a long timeout costs nothing when the machine is idle. It
// has to outlast a loaded CI box, where the plan tick (1 s), the bubble tick (0.5 s) and the
// frames that move the anchors all run late: 15 s was too short there (M9.11).
const POLL = { timeout: 60_000, interval: 100 };
const TURN_MS = 6000;

let city: Harness | undefined;
beforeEach(() => {
  lightingController.setSetting("always-day");
  getSettingsStore().set("breakTime", true);
});
afterEach(async () => {
  await city?.unmount();
  city = undefined;
  lightingController.setSetting("cycle");
  getSettingsStore().set("breakTime", true);
});

const theme = () => themeController.store.getState().themeId;
const chatter = () =>
  [...document.querySelectorAll('[data-testid="quip-bubble"][data-level="chatter"]')].map((el) => ({
    agentId: el.getAttribute("data-agent-id"),
    text: el.textContent?.trim(),
  }));
const rowOf = (h: Harness, id: string) => h.labels.getSnapshot().find((r) => r.id === id);

/**
 * Two agent ids and a moment `at` (inside one 6 s turn t, with turn t + 1 also running 6 s later)
 * at which the pure planner has them in one conversation. Searches the seeded plans.
 */
function findPair(): { a: string; b: string; at: number } {
  for (let i = 0; i < 600; i++) {
    const ids = [`p${i}`, `q${i}`];
    const phases = { [ids[0] as string]: "waiting", [ids[1] as string]: "waiting" } as const;
    const probe = planAt(phases, WAITING_SINCE + 125 * SECOND);
    const first = probe.conversations[0];
    if (first === undefined) continue;
    const at = first.turnStartedAt + 500;
    const now = planAt(phases, at).conversations[0];
    const later = planAt(phases, at + TURN_MS).conversations[0];
    if (
      now !== undefined &&
      later !== undefined &&
      now.a === first.a &&
      now.b === first.b &&
      later.a === now.a &&
      later.b === now.b &&
      later.turn === now.turn + 1
    ) {
      return { a: now.a, b: now.b, at };
    }
  }
  throw new Error("no seeded pair chats across two turns in 600 tries");
}

function planAt(phases: Record<string, "waiting" | "working">, now: number) {
  const store = createDataStore({ now: () => now });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(stateOf(phases));
  return expectedPlan(store, now);
}

async function chattingPair(): Promise<{ h: Harness; a: string; b: string; at: number }> {
  const { a, b, at } = findPair();
  const h = await mountCity({ [a]: "working", [b]: "working" }, ({ store, anchors }) => (
    <Bubbles {...overlayProps(anchors)} store={store} />
  ));
  city = h;
  h.clock.now = WAITING_SINCE + 9 * SECOND;
  h.apply(stateOf({ [a]: "waiting", [b]: "waiting" }));
  await h.frames(3);
  h.clock.now = at;
  // The bubble layer only shows a speaker whose anchor projects on screen, and anchors move per
  // frame: let a few frames run on the new clock before the tests start polling.
  await h.frames(3);
  return { h, a, b, at };
}

describe("break chatter in the city", () => {
  it("alternates the speakers of two agents on break over two 6 s turns", async () => {
    const { h, a, b, at } = await chattingPair();
    const conversation = (now: number): Conversation => {
      const c = expectedPlan(h.store, now).conversations[0];
      if (c === undefined) throw new Error("no conversation");
      return c;
    };

    const first = conversation(at);
    const firstLine = pickBanterLine({ conversation: first, theme: theme() });
    await expect
      .poll(chatter, POLL)
      .toEqual([{ agentId: firstLine.speakerId, text: firstLine.line }]);

    h.clock.now = at + TURN_MS;
    const second = conversation(h.clock.now);
    const secondLine = pickBanterLine({ conversation: second, theme: theme() });
    expect(secondLine.speakerId).not.toBe(firstLine.speakerId);
    expect([a, b]).toContain(secondLine.speakerId);
    await expect
      .poll(chatter, POLL)
      .toEqual([{ agentId: secondLine.speakerId, text: secondLine.line }]);
  }, 240_000);

  it("sends everyone back and removes the notes and chatter when Break time is turned off", async () => {
    const { h, a, b } = await chattingPair();
    await expect.poll(() => rowOf(h, a)?.onBreak, POLL).toBe(true);
    await expect.poll(() => rowOf(h, b)?.onBreak, POLL).toBe(true);
    const line = pickBanterLine({
      conversation: expectedPlan(h.store, h.clock.now).conversations[0] as Conversation,
      theme: theme(),
    });
    await expect.poll(chatter, POLL).toEqual([{ agentId: line.speakerId, text: line.line }]);
    const spot = breakPoint(expectedPlan(h.store, h.clock.now).agents.get(a) as AgentBreak);
    await expect
      .poll(() => dist(h.at(a) as { x: number; z: number }, spot), POLL)
      .toBeLessThan(0.15);

    getSettingsStore().set("breakTime", false);

    await expect.poll(() => rowOf(h, a)?.onBreak ?? false, POLL).toBe(false);
    await expect.poll(() => rowOf(h, b)?.onBreak ?? false, POLL).toBe(false);
    await expect.poll(() => chatter().length, POLL).toBe(0);
    // Away from the break spot, and the recorded status was never touched.
    await expect
      .poll(() => dist(h.at(a) as { x: number; z: number }, spot), POLL)
      .toBeGreaterThan(1);
    expect(rowOf(h, a)?.status).toBe("Waiting");
    expect(h.emotesOf(a)).toEqual(expect.not.arrayContaining(["mug", "puff", "sparkle", "note"]));
  }, 240_000);
});

describe("break time in the agent panel", () => {
  it("shows 'on break' next to Waiting for the selected agent on break", async () => {
    const h = await mountCity({ a1: "working" });
    city = h;
    h.clock.now = WAITING_SINCE + 9 * SECOND;
    h.apply(stateOf({ a1: "waiting" }));
    h.clock.now = WAITING_SINCE + 125 * SECOND;
    const Panel = presentedAgentPanelOverlay.Component;
    const props = {
      ...overlayProps(h.anchors, "a1"),
      renderTab: () => null,
    } as unknown as OverlayProps;
    await render(
      <PresentedSidebar store={h.store} recordedTarget={undefined}>
        <Panel {...props} />
      </PresentedSidebar>,
    );
    const text = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim();
    await expect.poll(() => text("agent-panel-status"), POLL).toBe("Waiting");
    await expect.poll(() => text("agent-panel-on-break"), POLL).toBe("on break");
  }, 120_000);
});

describe("break time in history", () => {
  it("places an agent directly at its break spot when the city mounts at a moment on break", async () => {
    // History remounts the city on the replay clock with place:true: no walk, the agent is just
    // there. Motion is not reduced, so only direct placement can put it there in a few frames.
    const now = WAITING_SINCE + 125 * SECOND;
    const h = await mountCity({ a1: "waiting" }, undefined, { now, reducedMotion: false });
    city = h;
    const planned = expectedPlan(h.store, now).agents.get("a1");
    if (planned === undefined) throw new Error("the pure planner has no break for a1");
    await h.frames(3);
    expect(dist(h.at("a1") as { x: number; z: number }, breakPoint(planned))).toBeLessThan(0.15);
    expect(rowOf(h, "a1")?.onBreak).toBe(true);
  }, 120_000);
});
