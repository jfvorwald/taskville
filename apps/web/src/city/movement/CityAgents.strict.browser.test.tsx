import { Canvas, type RootState } from "@react-three/fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { eventBuilder, PROJECT, registered } from "../../../test/data/fake-engine.ts";
import { initialState, type ProjectState, reduce } from "../../data/domain.ts";
import { createDataStore } from "../../data/store.ts";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { CityAgents } from "./CityAgents.tsx";
import { createLabelStore } from "./labels.ts";

// M5.13 red round 2 (roborev 6793): strict attribution must reach the city's own red state, not
// only TeamAttribution. CityAgents reads attention for the agent views and navigation (the label
// status and the urgent flag that wins label collisions); that input goes through
// useAttributedView, which reads the app-wide settings store (getSettingsStore()).
//
// The state is the split-pane seq 17 shape: the lead has an open, heuristic, non-answerable
// permission request (the worker prompt, "for: pip"). With strict on the lead's row has no
// "Needs you" status and is not urgent; with strict off it has both. A recorded (non-heuristic)
// prompt on the lead stays red under strict.
// Run: pnpm --filter @taskville/web test:browser src/city/movement/CityAgents.strict --browser.screenshotFailures=false

const FRAME_WAIT = { timeout: 10_000 };

function stateWithRequest(heuristic: boolean): ProjectState {
  const base = registered(eventBuilder(), "lead").reduce(reduce, initialState(PROJECT));
  return {
    ...base,
    requests: {
      r1: {
        id: "r1",
        agentId: "lead",
        kind: "permission",
        answerable: false,
        openedAt: "2026-10-30T10:00:20.868Z",
        state: "open",
        late: false,
        mergedRequestIds: [],
        ...(heuristic ? { heuristic: true } : {}),
        reason: { text: "for: pip (Bash)", masked: false, truncated: false },
      },
    },
  } as unknown as ProjectState;
}

// Round 3: one agent silent past the threshold ("quiet for 29 min", heuristic trouble).
const QUIET_NOW = Date.parse("2026-10-30T10:30:00.000Z");

function stateWithSilentAgent(): ProjectState {
  const emit = eventBuilder();
  return [...registered(emit, "quiet"), emit("agent.connected", "quiet")].reduce(
    reduce,
    initialState(PROJECT),
  );
}

async function mount(heuristic: boolean, silent = false) {
  const store = createDataStore({
    now: () => (silent ? QUIET_NOW : Date.parse("2026-10-30T10:00:25.000Z")),
  });
  store.getState().reset(PROJECT);
  store
    .getState()
    .applySnapshotState(silent ? stateWithSilentAgent() : stateWithRequest(heuristic));
  // Guard the premise: the domain says this is a needs_you record, heuristic or not.
  expect(store.getState().attention[0]).toMatchObject(
    silent
      ? { agentId: "quiet", level: "trouble", kind: "silent", heuristic: true }
      : { agentId: "lead", level: "needs_you", heuristic },
  );
  const labels = createLabelStore();
  let root: RootState | undefined;
  const screen = await render(
    <div style={{ width: 240, height: 180 }}>
      <Canvas
        camera={{ position: [0, 3, 6], fov: 40 }}
        onCreated={(s) => {
          root = s;
        }}
      >
        <CityAgents store={store} labels={labels} reducedMotion={true} />
      </Canvas>
    </div>,
  );
  const row = () => labels.getSnapshot().find((r) => r.id === (silent ? "quiet" : "lead"));
  await vi.waitFor(() => expect(row()).toBeDefined(), FRAME_WAIT);
  const target = (root?.gl.info.render.frame ?? 0) + 4;
  await vi.waitFor(
    () => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target),
    FRAME_WAIT,
  );
  return { row, screen, root: () => root };
}

afterEach(() => getSettingsStore().set("strictAttribution", false));

describe("CityAgents under strict teammate attribution", () => {
  it("shows the heuristic worker prompt as the lead's red state when strict is off", async () => {
    getSettingsStore().set("strictAttribution", false);
    const { row, screen } = await mount(true);
    try {
      expect(row()?.urgent).toBe(true);
      expect(row()?.status).toMatch(/Needs you/);
    } finally {
      await screen.unmount();
    }
  }, 30_000);

  it("leaves the lead's city status and needs-you state unset when strict is on", async () => {
    getSettingsStore().set("strictAttribution", true);
    const { row, screen } = await mount(true);
    try {
      expect(row()?.urgent).toBe(false);
      expect(row()?.status).not.toMatch(/Needs you/);
    } finally {
      await screen.unmount();
    }
  }, 30_000);

  it("restores the red state when strict is switched off while mounted", async () => {
    getSettingsStore().set("strictAttribution", true);
    const { row, screen } = await mount(true);
    try {
      expect(row()?.urgent).toBe(false);
      getSettingsStore().set("strictAttribution", false);
      await vi.waitFor(() => expect(row()?.urgent).toBe(true), FRAME_WAIT);
      expect(row()?.status).toMatch(/Needs you/);
    } finally {
      await screen.unmount();
    }
  }, 30_000);

  it("still turns the lead red for a recorded (non-heuristic) prompt when strict is on", async () => {
    getSettingsStore().set("strictAttribution", true);
    const { row, screen } = await mount(false);
    try {
      expect(row()?.urgent).toBe(true);
      expect(row()?.status).toMatch(/Needs you/);
    } finally {
      await screen.unmount();
    }
  }, 30_000);
});

describe("CityAgents keeps silence trouble under strict teammate attribution (round 3)", () => {
  it("shows the heuristic silence trouble with strict off (control)", async () => {
    getSettingsStore().set("strictAttribution", false);
    const { row, screen } = await mount(false, true);
    try {
      expect(row()?.status).toMatch(/Possible trouble/);
    } finally {
      await screen.unmount();
    }
  }, 30_000);

  it("keeps an agent's silence trouble status and city mark when strict is on", async () => {
    getSettingsStore().set("strictAttribution", true);
    const { row, screen, root } = await mount(false, true);
    try {
      expect(row()?.status).toMatch(/Possible trouble/);
      // The city mark: the agent's drawing carries an attention ring (amber for trouble).
      let ring = false;
      root()?.scene.traverse((o) => {
        if ((o as { geometry?: { type?: string } }).geometry?.type === "RingGeometry") ring = true;
      });
      expect(ring).toBe(true);
    } finally {
      await screen.unmount();
    }
  }, 30_000);
});
