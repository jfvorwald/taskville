import { Canvas, type RootState } from "@react-three/fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../test/data/fake-engine.ts";
import { FADE_MS, HAND_OVER_MS, RETURN_MS } from "../../city/crew/subagents/lifecycle.ts";
import { stateOf as attentionState } from "../../city/crew/subagents/testScene.tsx";
import { CityRoot } from "../../city/index.tsx";
import { type Agent, initialState, type ProjectState } from "../../data/domain.ts";
import { dataStore } from "../../data/store.ts";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayProps } from "../host/types.ts";
import { AgentList } from "./AgentList.tsx";

// M5.02 round 3 (roborev 6109): a subagent the crew layer draws has no block-agent view, so the
// world labels (built from block-agent views) no longer list it. That is accepted for the labels,
// but the accessible agent list is the only way for keyboard and screen reader users to reach an
// agent, so it must still list every subagent with its name, kind and status, and selecting it
// there must select the agent (the id its crew bot carries).
//
// The scene is the real city (`CityRoot`) over the app-wide store, next to the real `AgentList`,
// so any way of feeding the list (labels, the store) is allowed; only the DOM is checked.

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

function stateOf(agents: readonly Agent[], reviewing: readonly string[]): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    activity: Object.fromEntries(
      reviewing.map((id) => [
        id,
        { agentId: id, activity: "reviewing", heuristic: false, since: T, openSessionCount: 1 },
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

afterEach(() => dataStore.getState().reset(PROJECT));

describe("AgentList with crew subagents", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "keeps a returning crew bot selectable with current attention (needsYou=%s, collapsed=%s)",
    async (needsYou, collapsed) => {
      const clock = { now: 0 };
      const now = vi.spyOn(dataStore, "now").mockImplementation(() => clock.now);
      const boss = agent("boss", { kind: "lead" });
      const kid = agent("kid", { kind: "subagent", parentAgentId: "boss", role: "Explore" });
      const siblings = collapsed
        ? ["s1", "s2", "s3"].map((id) => agent(id, { kind: "subagent", parentAgentId: "boss" }))
        : [];
      dataStore.getState().reset(PROJECT);
      dataStore
        .getState()
        .applySnapshotState(attentionState([boss, ...siblings, kid], needsYou ? ["kid"] : []));
      let root: RootState | undefined;
      const screen = await render(
        <>
          <AgentList {...props()} />
          <div style={{ width: 240, height: 180 }}>
            <Canvas
              onCreated={(state) => {
                root = state;
              }}
            >
              <CityRoot />
            </Canvas>
          </div>
        </>,
      );
      const frames = async (count: number) => {
        const target = (root?.gl.info.render.frame ?? 0) + count;
        await vi.waitFor(
          () => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target),
          WAIT,
        );
      };
      const bot = () => {
        let found = false;
        root?.scene.traverse((object) => {
          if (object.userData.agentId === "kid") found = true;
        });
        return found;
      };
      try {
        await expect.element(page.getByRole("row", { name: /KID/ }), WAIT).toBeInTheDocument();
        if (needsYou) {
          await expect
            .element(page.getByRole("row", { name: /KID/ }))
            .toMatchTextContent("Needs you");
        }
        clock.now = 10_000;
        await frames(5);
        expect(bot()).toBe(true);
        if (collapsed) {
          let hidden = false;
          root?.scene.traverse((object) => {
            if (object.userData.agentId === "kid" && !object.visible) hidden = true;
          });
          expect(hidden).toBe(true);
        }
        dataStore
          .getState()
          .applySnapshotState(stateOf([boss, ...siblings, { ...kid, finishedAt: T }], []));
        await frames(5);
        expect(bot()).toBe(true);
        const rows = page.getByRole("row", { name: /KID/ }).elements();
        expect.soft(rows).toHaveLength(1);
        expect.soft(rows[0]?.textContent).not.toMatch(/Needs you/);
        if (rows[0] !== undefined) {
          (rows[0] as HTMLElement).focus();
          await userEvent.keyboard("{Enter}");
        }
        expect.soft(dataStore.getState().selectedAgentId).toBe("kid");
        clock.now += RETURN_MS + HAND_OVER_MS + FADE_MS + 1;
        await frames(8);
        await vi.waitFor(() => expect(bot()).toBe(false), WAIT);
        await expect.element(page.getByRole("row", { name: /KID/ }), WAIT).not.toBeInTheDocument();
        expect(dataStore.getState().agents).toHaveLength(siblings.length + 2);
      } finally {
        await screen.unmount();
        now.mockRestore();
      }
    },
    30_000,
  );

  it("lists a subagent with a known parent by name, kind and status, and selects it on Enter", async () => {
    dataStore.getState().reset(PROJECT);
    dataStore
      .getState()
      .applySnapshotState(
        stateOf(
          [
            agent("boss", { kind: "lead" }),
            agent("kid", { kind: "subagent", parentAgentId: "boss", role: "Explore" }),
          ],
          ["boss", "kid"],
        ),
      );

    const screen = await render(
      <>
        <AgentList {...props()} />
        <div style={{ width: 240, height: 180 }}>
          <Canvas camera={{ position: [0, 3, 6], fov: 40 }}>
            <CityRoot />
          </Canvas>
        </div>
      </>,
    );
    try {
      // The lead is a block agent: the control that proves the list is fed by the city.
      await expect.element(page.getByRole("row", { name: /BOSS/ }), WAIT).toBeInTheDocument();

      // The crew subagent has no block-agent view, and is still in the list.
      const row = page.getByRole("row", { name: /KID/ });
      await expect.element(row, WAIT).toBeInTheDocument();
      expect(row.element().textContent).toMatch(/subagent/i);
      expect(row.element().textContent).toMatch(/Reviewing/);
      // One row per agent: the subagent is listed once.
      expect(page.getByRole("row", { name: /KID/ }).elements()).toHaveLength(1);

      // Selecting it in the list selects the agent (the id the crew bot carries).
      (row.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(dataStore.getState().selectedAgentId).toBe("kid"), WAIT);
    } finally {
      await screen.unmount();
    }
  }, 30_000);
});
