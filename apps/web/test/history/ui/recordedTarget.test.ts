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

// M6.10 (#312): the lookup is bounded by the log's size, not walked per playback tick. Work is
// counted as moment reads (integer-indexed gets), never as wall-clock time.
describe("recordedCardTarget work bound", () => {
  it("reads a bounded number of moments for a head deep in a large recording", () => {
    const N = 30_000;
    const requests: Request[] = [];
    const list: ReturnType<typeof moment>[] = [];
    for (let seq = 1; seq <= N; seq += 1) {
      if (seq % 3 === 0) {
        const id = `r-${seq}`;
        requests.push(request(id, ADA));
        list.push(moment(seq, ADA, id));
      } else {
        list.push(moment(seq, BEA));
      }
    }
    let reads = 0;
    const counted = new Proxy(list, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const head = 20_000; // the nearest ADA request at or before the head is sequence 19_998
    const target = recordedCardTarget({
      state: stateWith(head, requests),
      moments: counted,
      selectedId: ADA,
    });
    expect(target?.requestId).toBe("r-19998");
    expect(reads).toBeLessThan(200);
  });

  // Round 2 (roborev 6757): an agent with no request, or only an early one, must not make every
  // playback update walk the log back to the start. Building a per-list index on the first call is
  // allowed, so one warm-up call is made before reads are counted; each later head change is then
  // bounded by the log's logarithm, not its length.
  function largeLog(extra: readonly ReturnType<typeof moment>[]) {
    const N = 30_000;
    const list: ReturnType<typeof moment>[] = [];
    const requests: Request[] = [];
    for (let seq = 1; seq <= N; seq += 1) {
      const early = extra.find((m) => m.sequence === seq);
      if (early !== undefined) {
        list.push(early);
        if (early.requestId !== undefined) requests.push(request(early.requestId, ADA));
      } else if (seq % 3 === 0) {
        list.push(moment(seq, BEA, `b-${seq}`));
        requests.push(request(`b-${seq}`, BEA));
      } else {
        list.push(moment(seq, BEA));
      }
    }
    let reads = 0;
    const counted = new Proxy(list, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    return {
      requests,
      counted,
      takeReads: () => {
        const n = reads;
        reads = 0;
        return n;
      },
    };
  }

  it("stays bounded per head change for an agent that never opened a request", () => {
    const { requests, counted, takeReads } = largeLog([]);
    const call = (head: number) =>
      recordedCardTarget({ state: stateWith(head, requests), moments: counted, selectedId: ADA });
    call(1_000); // warm-up
    takeReads();
    for (const head of [29_999, 25_000, 20_001, 12_345, 7_000]) {
      expect(call(head)).toBeNull();
      expect(takeReads()).toBeLessThan(200);
    }
  });

  it("stays bounded per head change for an agent whose only request is early in the log", () => {
    const { requests, counted, takeReads } = largeLog([moment(5, ADA, "r-early")]);
    const call = (head: number) =>
      recordedCardTarget({ state: stateWith(head, requests), moments: counted, selectedId: ADA });
    call(1_000); // warm-up
    takeReads();
    for (const head of [29_999, 25_000, 20_001, 12_345, 7_000]) {
      expect(call(head)?.requestId).toBe("r-early");
      expect(takeReads()).toBeLessThan(200);
    }
    expect(call(4)).toBeNull(); // not yet opened at an earlier head
  });
});
