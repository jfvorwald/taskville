import { describe, expect, it } from "vitest";
import { cardTarget } from "../../../src/overlays/action-card/target.ts";

// M4.07: which request the action card is about. The card opens for the selected agent when that
// agent has a `needs_you` attention record that points at a request (ARCHITECTURE.md 2.4).
// `attention` is most urgent first, as the store keeps it.

const SINCE = "2026-11-01T11:55:00.000Z";

type Attn = Parameters<typeof cardTarget>[0]["attention"][number];

const record = (agentId: string, over: Partial<Attn> = {}): Attn => ({
  agentId,
  level: "needs_you",
  kind: "permission",
  since: SINCE,
  requestId: `req-${agentId}`,
  heuristic: false,
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  id: "req-a1",
  agentId: "a1",
  sessionId: "sess-1",
  kind: "permission",
  toolName: "Bash",
  answerable: true,
  openedAt: SINCE,
  state: "open",
  ...over,
});

describe("cardTarget", () => {
  it("is null with nothing selected", () => {
    expect(
      cardTarget({
        selectedId: null,
        attention: [record("a1")],
        requests: { "req-a1": request() },
        agents: {},
      }),
    ).toBeNull();
  });

  it.each([
    ["a waiting agent", { level: "waiting", kind: "idle" }],
    ["a trouble agent", { level: "trouble", kind: "tool_failures" }],
  ])("is null for %s: only needs-you opens the card", (_name, over) => {
    const attention = [record("a1", { ...over, requestId: undefined } as Partial<Attn>)];
    expect(cardTarget({ selectedId: "a1", attention, requests: {}, agents: {} })).toBeNull();
  });

  it("is null when the selected agent has no record, even if another agent needs you", () => {
    expect(
      cardTarget({
        selectedId: "a2",
        attention: [record("a1")],
        requests: { "req-a1": request() },
        agents: {},
      }),
    ).toBeNull();
  });

  it("describes a bridge-held permission request", () => {
    const target = cardTarget({
      selectedId: "a1",
      attention: [record("a1")],
      requests: { "req-a1": request() },
      agents: { a1: { displayName: "Ada" } },
    });
    expect(target).toMatchObject({
      agentId: "a1",
      agentName: "Ada",
      requestId: "req-a1",
      sessionId: "sess-1",
      toolName: "Bash",
      sinceMs: Date.parse(SINCE),
      answerable: true,
      requestState: "open",
    });
  });

  it("names the agent by its id when it has no display name", () => {
    const target = cardTarget({
      selectedId: "a1",
      attention: [record("a1")],
      requests: { "req-a1": request() },
      agents: { a1: {} },
    });
    expect(target?.agentName).toBe("a1");
  });

  it("is not answerable for a telemetry-only request, and carries its reason text", () => {
    const target = cardTarget({
      selectedId: "a1",
      attention: [record("a1", { kind: "input" })],
      requests: {
        "req-a1": request({
          answerable: false,
          kind: "input",
          toolName: undefined,
          reason: { text: "Claude needs your input", masked: false, truncated: false },
        }),
      },
      agents: {},
    });
    expect(target).toMatchObject({ answerable: false, reason: "Claude needs your input" });
  });

  it("is not answerable when the request is missing from state (never offer a decision on a guess)", () => {
    const target = cardTarget({
      selectedId: "a1",
      attention: [record("a1")],
      requests: {},
      agents: {},
    });
    expect(target).toMatchObject({ requestId: "req-a1", answerable: false });
  });

  it("takes the agent's most urgent needs-you record: the first in the list", () => {
    const attention = [
      record("a1", { requestId: "req-new", since: "2026-11-01T11:59:00.000Z" }),
      record("a1", { requestId: "req-old" }),
    ];
    const target = cardTarget({
      selectedId: "a1",
      attention,
      requests: { "req-new": request({ id: "req-new" }), "req-old": request({ id: "req-old" }) },
      agents: {},
    });
    expect(target?.requestId).toBe("req-new");
  });

  it("reports the recorded request state when it is not open", () => {
    const target = cardTarget({
      selectedId: "a1",
      attention: [record("a1")],
      requests: { "req-a1": request({ state: "expired" }) },
      agents: {},
    });
    expect(target?.requestState).toBe("expired");
  });
});
