import { describe, expect, it } from "vitest";
import { initialState, type ProjectState } from "../../../src/data/domain.ts";
import { recordedCardTarget } from "../../../src/history/ui/recordedTarget.ts";
import { PROJECT } from "../../data/fake-engine.ts";

const ADA = "agent-ada";
const BEA = "agent-bea";

type Request = ProjectState["requests"][string];

function request(id: string, agentId: string, overrides: Partial<Request> = {}): Request {
  return {
    id,
    agentId,
    sessionId: `session-${id}`,
    kind: "permission",
    toolName: "Read",
    inputPreview: `preview ${id}`,
    answerable: false,
    openedAt: "2026-10-31T12:00:00.000Z",
    state: "open",
    late: false,
    mergedRequestIds: [],
    ...overrides,
  } as Request;
}

/** A replayed state holding the given requests, every named agent registered, at `head`. */
function stateWith(head: number, requests: readonly Request[]): ProjectState {
  const base = initialState(PROJECT);
  const agents = Object.fromEntries(
    [ADA, BEA].map((id) => [id, { ...base, id, displayName: `Name ${id}` }]),
  );
  return {
    ...base,
    head,
    agents,
    requests: Object.fromEntries(requests.map((r) => [r.id, r])),
  } as unknown as ProjectState;
}

// The moments the provider records: `requestId` only on a non-late request.opened.
const moment = (sequence: number, agentId: string | undefined, requestId?: string) => ({
  sequence,
  agentId,
  ...(requestId === undefined ? {} : { requestId }),
});

describe("recordedCardTarget", () => {
  it("never targets a late request: its moment carries no requestId", () => {
    const state = stateWith(3, [
      request("r-open", ADA),
      request("r-late", ADA, { late: true, state: "expired" }),
    ]);
    const target = recordedCardTarget({
      state,
      moments: [moment(1, ADA), moment(2, ADA, "r-open"), moment(3, ADA)],
      selectedId: ADA,
    });
    expect(target?.requestId).toBe("r-open");
  });

  it("has no target when the only recorded request is a late one", () => {
    const state = stateWith(2, [request("r-late", ADA, { late: true, state: "expired" })]);
    expect(
      recordedCardTarget({
        state,
        moments: [moment(1, ADA), moment(2, ADA)],
        selectedId: ADA,
      }),
    ).toBeNull();
  });

  it("takes the most recent request at or before the head, and the earlier one when rewound", () => {
    const requests = [request("a-first", ADA), request("a-second", ADA)];
    const moments = [moment(1, ADA, "a-first"), moment(2, ADA, "a-second")];
    expect(
      recordedCardTarget({ state: stateWith(2, requests), moments, selectedId: ADA })?.requestId,
    ).toBe("a-second");
    // Rewound between them: the replayed state does not hold the later request, and a moment
    // past the head is not considered even if some state held the request.
    expect(
      recordedCardTarget({
        state: stateWith(1, [requests[0] as Request]),
        moments,
        selectedId: ADA,
      })?.requestId,
    ).toBe("a-first");
    expect(
      recordedCardTarget({ state: stateWith(1, requests), moments, selectedId: ADA })?.requestId,
    ).toBe("a-first");
  });

  it("never hands another agent's open request to the selected agent", () => {
    const requests = [request("a-first", ADA), request("b-only", BEA)];
    const moments = [moment(1, ADA, "a-first"), moment(2, BEA, "b-only")];
    expect(
      recordedCardTarget({ state: stateWith(2, requests), moments, selectedId: ADA })?.requestId,
    ).toBe("a-first");
    expect(
      recordedCardTarget({ state: stateWith(2, requests), moments, selectedId: BEA })?.requestId,
    ).toBe("b-only");
    // The moment names the selected agent but the replayed request belongs to another one.
    expect(
      recordedCardTarget({
        state: stateWith(1, [request("b-only", BEA)]),
        moments: [moment(1, ADA, "b-only")],
        selectedId: ADA,
      }),
    ).toBeNull();
  });
});
