import { Canvas, type RootState } from "@react-three/fiber";
import type { Object3D, Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { type Agent, initialState, type ProjectState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../../overlays/host/index.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { crewMarkerLabel } from "./crew.ts";
import { FADE_MS, HAND_OVER_MS, RETURN_MS } from "./lifecycle.ts";
import { pillMaterial } from "./resources.ts";
import { SubagentCrew } from "./SubagentCrew.tsx";
import { TINT_HEX } from "./tint.ts";

// The crew layer in a real R3F scene (roborev fixes for M5.02):
//  - a crew bot carries `userData.agentId`, so picking a bot selects that agent;
//  - the crew of a bot that is out of sight (behind a "+N crew" marker, gone, or under a parent
//    that is itself out of sight) is out of sight too, through every generation, until fan-out.
// A bot is "shown" when it and every group above it are visible, which is what the renderer draws.

const FRAME_WAIT = { timeout: 10_000 };
const T = "2026-10-31T10:00:00.000Z";
const WORKING_MS = 10_000;
const VISIT_MS = RETURN_MS + HAND_OVER_MS + FADE_MS;

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    sourceId: "demo:7",
    sourceAgentId: id,
    displayName: id.toUpperCase(),
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: T,
    lastSeenAt: T,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  } as Agent;
}

const sub = (id: string, parentAgentId: string, extra: Partial<Agent> = {}): Agent =>
  agent(id, { kind: "subagent", parentAgentId, role: "Explore", ...extra });

function stateOf(agents: readonly Agent[]): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  } as unknown as ProjectState;
}

interface Scene {
  root: () => RootState;
  clock: { now: number };
  store: ReturnType<typeof createDataStore>;
  anchors: ReturnType<typeof createAnchorSource>;
  set(agents: readonly Agent[]): void;
  bot(id: string): Object3D | undefined;
  shown(id: string): boolean;
  frames(n: number): Promise<void>;
  unmount(): Promise<void>;
}

async function mount(agents: readonly Agent[]): Promise<Scene> {
  const clock = { now: 0 };
  const store = createDataStore({ now: () => clock.now });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(stateOf(agents));
  const anchors = createAnchorSource();
  anchors.setAnchor(agentAnchorId("lead"), [2, 0, 3]);

  let captured: RootState | undefined;
  const screen = await render(
    <div style={{ width: 240, height: 180 }}>
      <Canvas
        camera={{ position: [0, 3, 6], fov: 40 }}
        onCreated={(s) => {
          captured = s;
        }}
      >
        <SubagentCrew store={store} anchors={anchors} />
      </Canvas>
    </div>,
  );
  await vi.waitFor(() => expect(captured).toBeDefined(), FRAME_WAIT);
  const root = (): RootState => {
    if (captured === undefined) throw new Error("scene not created");
    return captured;
  };
  const bot = (id: string): Object3D | undefined => {
    let found: Object3D | undefined;
    root().scene.traverse((o) => {
      if (o.userData.agentId === id) found = o;
    });
    return found;
  };
  const shown = (id: string): boolean => {
    for (let o: Object3D | null | undefined = bot(id); o; o = o.parent) {
      if (!o.visible) return false;
    }
    return bot(id) !== undefined;
  };
  const frames = async (n: number): Promise<void> => {
    const target = root().gl.info.render.frame + n;
    await vi.waitFor(
      () => expect(root().gl.info.render.frame).toBeGreaterThanOrEqual(target),
      FRAME_WAIT,
    );
  };
  return {
    root,
    clock,
    store,
    anchors,
    set: (next) => store.getState().applySnapshotState(stateOf(next)),
    bot,
    shown,
    frames,
    unmount: () => screen.unmount(),
  };
}

/** The `onClick` R3F was given for `o`, so a test can click a sprite without a pointer. */
const clickOf = (o: Object3D): unknown =>
  (o as unknown as { __r3f?: { props?: { onClick?: unknown } } }).__r3f?.props?.onClick;

// Three subagents get a bot each; the fourth is behind the "+1 crew" marker. A child of the
// first subagent has a visible parent; a child of the fourth has a parent nobody can see.
const LEAD = agent("lead", { kind: "lead" });
const CREW = [
  sub("s1", "lead"),
  sub("s2", "lead"),
  sub("s3", "lead"),
  sub("s4", "lead"),
  sub("visibleChild", "s1"),
  sub("hiddenChild", "s4"),
];

describe("SubagentCrew in a scene", () => {
  it("carries the subagent's id on its bot so picking selects that agent", async () => {
    const scene = await mount([LEAD, ...CREW]);
    try {
      await scene.frames(3);
      for (const id of ["s1", "s2", "s3", "s4", "visibleChild", "hiddenChild"]) {
        expect(scene.bot(id), id).toBeDefined();
      }
      // One bot per subagent: no id appears on two groups.
      const seen: string[] = [];
      scene.root().scene.traverse((o) => {
        if (typeof o.userData.agentId === "string") seen.push(o.userData.agentId);
      });
      expect(seen.sort()).toEqual(["hiddenChild", "s1", "s2", "s3", "s4", "visibleChild"]);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("hides the crew of a bot behind the +N marker until the marker is clicked", async () => {
    const scene = await mount([LEAD, ...CREW]);
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("visibleChild")).toBe(true), FRAME_WAIT);
      expect(scene.shown("s1")).toBe(true);
      expect(scene.shown("s3")).toBe(true);
      // The fourth is behind the marker, so its own child has nowhere to stand.
      expect(scene.shown("s4")).toBe(false);
      expect(scene.shown("hiddenChild")).toBe(false);

      // Fan-out: a click on the lead's marker shows every bot, and then the child of the fourth.
      // (Every family has a marker sprite; the lead's is the one beside the lead's bots.)
      const family = scene.bot("s1")?.parent;
      const marker = family?.children.find((o) => typeof clickOf(o) === "function");
      expect(marker).toBeDefined();
      (clickOf(marker as Object3D) as () => void)();
      await vi.waitFor(() => expect(scene.shown("s4")).toBe(true), FRAME_WAIT);
      await vi.waitFor(() => expect(scene.shown("hiddenChild")).toBe(true), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("paints the +N marker with the red of a hidden subagent that needs you", async () => {
    // s4 is behind the "+1 crew" marker; it has an open request, so the marker must say so.
    const scene = await mount([LEAD, sub("s1", "lead"), sub("s2", "lead"), sub("s3", "lead")]);
    try {
      const withHidden = stateOf([LEAD, ...CREW.slice(0, 4)]);
      scene.store.getState().applySnapshotState({
        ...withHidden,
        requests: {
          r1: {
            id: "r1",
            agentId: "s4",
            kind: "permission",
            answerable: false,
            openedAt: T,
            state: "open",
            late: false,
            mergedRequestIds: [],
          },
        },
      } as unknown as ProjectState);
      expect(scene.store.getState().attention[0]).toMatchObject({
        agentId: "s4",
        level: "needs_you",
      });
      await scene.frames(2);
      scene.clock.now = WORKING_MS;

      const marker = (): Sprite | undefined =>
        scene
          .bot("s1")
          ?.parent?.children.find((o): o is Sprite => typeof clickOf(o) === "function");
      await vi.waitFor(
        () => expect(marker()?.material).toBe(pillMaterial(crewMarkerLabel(1), TINT_HEX.red)),
        FRAME_WAIT,
      );
      // And not the plain pill a quiet marker gets.
      expect(marker()?.material).not.toBe(pillMaterial(crewMarkerLabel(1)));
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("keeps the plain +N marker while no hidden subagent needs you", async () => {
    const scene = await mount([LEAD, ...CREW.slice(0, 4)]);
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      const marker = (): Sprite | undefined =>
        scene
          .bot("s1")
          ?.parent?.children.find((o): o is Sprite => typeof clickOf(o) === "function");
      await vi.waitFor(
        () => expect(marker()?.material).toBe(pillMaterial(crewMarkerLabel(1))),
        FRAME_WAIT,
      );
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("keeps a running subagent drawn once its parent bot has finished and faded", async () => {
    const scene = await mount([LEAD, sub("s1", "lead"), sub("kid", "s1")]);
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("kid")).toBe(true), FRAME_WAIT);

      scene.set([LEAD, sub("s1", "lead", { finishedAt: T }), sub("kid", "s1")]);
      // The tracker sees the finish on the next render, at the clock of that moment.
      await scene.frames(3);
      scene.clock.now = WORKING_MS + VISIT_MS + 100;
      // The parent's bot has left the city...
      await vi.waitFor(() => expect(scene.shown("s1")).toBe(false), FRAME_WAIT);
      // ...but a subagent that is still running must never disappear because of it (roborev
      // 6395): it stays drawn, and its bot still carries the id that picking selects.
      await scene.frames(3);
      expect(scene.shown("kid")).toBe(true);
      scene.clock.now = WORKING_MS + VISIT_MS + 60_000;
      await scene.frames(3);
      expect(scene.shown("kid")).toBe(true);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("keeps running subagents drawn, nested ones too, when the top parent leaves the city", async () => {
    const scene = await mount([LEAD, sub("s1", "lead"), sub("kid", "s1")]);
    try {
      await scene.frames(2);
      scene.clock.now = WORKING_MS;
      await vi.waitFor(() => expect(scene.shown("kid")).toBe(true), FRAME_WAIT);
      expect(scene.shown("s1")).toBe(true);

      // The lead has left the city: its anchor is gone. Its subagents are still running.
      scene.anchors.replaceAnchors("agent:", {});
      await scene.frames(3);
      expect(scene.shown("s1")).toBe(true);
      expect(scene.shown("kid")).toBe(true);
      scene.clock.now = WORKING_MS + 60_000;
      await scene.frames(3);
      expect(scene.shown("s1")).toBe(true);
      expect(scene.shown("kid")).toBe(true);
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});
