import { Canvas } from "@react-three/fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../test/data/fake-engine.ts";
import { type Agent, initialState, type ProjectState } from "../../data/domain.ts";
import { dataStore } from "../../data/store.ts";
import { AgentList } from "../../overlays/agent-list/AgentList.tsx";
import { createAnchorSource } from "../../overlays/host/anchors.ts";
import type { OverlayProps } from "../../overlays/host/types.ts";
import { CityRoot } from "../index.tsx";
import { AgentLabels } from "./AgentLabels.tsx";
import { movementLabels } from "./labels.ts";

// The real city, the world labels and the accessible agent list over one store (M5.02 round 5):
//  - the world labels tag block agents only: a subagent the crew layer draws has no label there;
//  - the agent list keeps it, with its kind word, and a subagent that needs you reads
//    "Needs you" and is marked urgent, so keyboard and screen reader users can find it.

const WAIT = { timeout: 10_000 };
const T = "2026-11-01T10:00:00.000Z";

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

function stateOf(agents: readonly Agent[], needsYou: readonly string[]): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    requests: Object.fromEntries(
      needsYou.map((agentId, i) => [
        `r${i}`,
        {
          id: `r${i}`,
          agentId,
          kind: "permission",
          answerable: false,
          openedAt: T,
          state: "open",
          late: false,
          mergedRequestIds: [],
        },
      ]),
    ),
  } as unknown as ProjectState;
}

function props(): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: null, select: (id) => dataStore.getState().select(id) },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_key, fallback) => fallback, set: () => {} },
  };
}

afterEach(() => {
  dataStore.getState().reset(PROJECT);
  movementLabels.set([]);
});

const labelled = (): string[] =>
  [...document.querySelectorAll('[data-testid="agent-label"]')].map(
    (el) => el.getAttribute("data-agent-id") ?? "",
  );

describe("world labels and the agent list with a crew subagent", () => {
  it("tags the block agent in the world, not the subagent; the list keeps both, the stuck one urgent", async () => {
    dataStore.getState().reset(PROJECT);
    dataStore
      .getState()
      .applySnapshotState(
        stateOf(
          [
            agent("boss", { kind: "lead" }),
            agent("kid", { kind: "subagent", parentAgentId: "boss", role: "Explore" }),
          ],
          ["kid"],
        ),
      );
    const overlay = props();
    const screen = await render(
      <>
        <AgentLabels {...overlay} />
        <AgentList {...overlay} />
        <div style={{ width: 240, height: 180 }}>
          <Canvas camera={{ position: [0, 3, 6], fov: 40 }}>
            <CityRoot />
          </Canvas>
        </div>
      </>,
    );
    try {
      // Both agents are in the list, so the city has published its rows.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-agent-id="kid"][role="row"]')).not.toBeNull();
        expect(document.querySelector('[data-agent-id="boss"][role="row"]')).not.toBeNull();
      }, WAIT);

      // The world labels: the block agent only.
      expect(labelled()).toEqual(["boss"]);

      // The list row of the stuck subagent: its kind, "Needs you", and urgent.
      const row = document.querySelector('[data-agent-id="kid"][role="row"]') as HTMLElement;
      expect(row.getAttribute("data-urgent")).toBe("true");
      expect(row.textContent).toMatch(/subagent/i);
      expect(row.textContent).toMatch(/needs you/i);
      const boss = document.querySelector('[data-agent-id="boss"][role="row"]') as HTMLElement;
      expect(boss.getAttribute("data-urgent")).toBeNull();
    } finally {
      await screen.unmount();
    }
  }, 30_000);
});
