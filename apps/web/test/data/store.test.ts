import { describe, expect, it } from "vitest";
import { createDataStore } from "../../src/data/store.ts";
import { eventBuilder, PROJECT, registered, stateHashAt } from "./fake-engine.ts";
import { initialState, reduce } from "../../src/data/domain.ts";

const NOW = Date.parse("2026-10-30T10:30:00Z");

describe("data store", () => {
  it("starts empty and connecting", () => {
    const store = createDataStore({ now: () => NOW });
    const s = store.getState();
    expect(s).toMatchObject({
      state: null,
      cursor: 0,
      connection: "connecting",
      error: null,
      agents: [],
      selectedAgentId: null,
    });
    expect(s.counts).toEqual({ needsYou: 0, trouble: 0, waiting: 0 });
  });

  it("derives agents, attention and header counts from the reducer state on each event", () => {
    const emit = eventBuilder();
    const store = createDataStore({ now: () => NOW });
    store.getState().reset(PROJECT);
    store.getState().applySnapshotState(initialState(PROJECT));
    for (const event of registered(emit, "a1", "a2")) store.getState().applyEvent(event);
    store.getState().applyEvent(emit("session.turn_failed", "a2"));

    const s = store.getState();
    expect(s.cursor).toBe(3);
    expect(s.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(s.counts.trouble).toBe(1);
    expect(s.attention.map((a) => [a.agentId, a.level])).toEqual([["a2", "trouble"]]);
  });

  it("keeps agent and attention references while an event leaves them alone", () => {
    const emit = eventBuilder();
    const store = createDataStore({ now: () => NOW });
    store.getState().reset(PROJECT);
    store.getState().applySnapshotState(
      registered(emit, "a1").reduce(reduce, initialState(PROJECT)),
    );
    const before = store.getState();
    store.getState().applyEvent(emit("agent.connected", "a1")); // changes a1, so refs change
    expect(store.getState().agents).not.toBe(before.agents);
    expect(stateHashAt([])).toBeTypeOf("string");
  });

  it("selects and clears an agent for navigation", () => {
    const store = createDataStore({ now: () => NOW });
    store.getState().select("a1");
    expect(store.getState().selectedAgentId).toBe("a1");
    store.getState().select(null);
    expect(store.getState().selectedAgentId).toBeNull();
  });

  it("reset to another project clears the view", () => {
    const emit = eventBuilder();
    const store = createDataStore({ now: () => NOW });
    store.getState().reset(PROJECT);
    store.getState().applySnapshotState(initialState(PROJECT));
    store.getState().applyEvent(registered(emit, "a1")[0] as never);
    store.getState().select("a1");
    store.getState().reset("other");
    expect(store.getState()).toMatchObject({
      projectId: "other",
      state: null,
      agents: [],
      selectedAgentId: null,
      connection: "connecting",
    });
  });

  it("refreshAttention recomputes time-based attention with the clock", () => {
    let now = NOW;
    const emit = eventBuilder();
    const store = createDataStore({ now: () => now });
    store.getState().reset(PROJECT);
    store
      .getState()
      .applySnapshotState(
        [...registered(emit, "a1"), emit("agent.connected", "a1")].reduce(
          reduce,
          initialState(PROJECT),
        ),
      );
    expect(store.getState().counts.trouble).toBe(0);
    now += 11 * 60_000; // past the 10 minute silent threshold
    store.getState().refreshAttention();
    expect(store.getState().counts.trouble).toBe(1);
  });
});
