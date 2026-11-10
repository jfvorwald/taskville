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

  // Round 3 (roborev 6779): a recent request-opening moment whose request was merged into an older
  // one is absent from the replayed state. It must not push the lookup into a walk over the whole
  // recording on each update; the retained distant request is still the answer.
  it("stays bounded when a recent opening moment was merged away and the request is distant", () => {
    const { requests, counted, takeReads } = largeLog([
      moment(5, ADA, "r-retained"),
      moment(29_990, ADA, "r-merged-away"),
    ]);
    const held = requests.filter((r) => r.id !== "r-merged-away");
    const call = (head: number) =>
      recordedCardTarget({ state: stateWith(head, held), moments: counted, selectedId: ADA });
    call(29_995); // warm-up
    takeReads();
    for (const head of [30_000, 29_999, 29_995, 29_991, 29_990]) {
      expect(call(head)?.requestId).toBe("r-retained");
      expect(takeReads()).toBeLessThan(200);
    }
  });
});

// M6.14 (#361): "resolve merged openings without a scan". The scan the issue means is the indexed
// fallback in recordedCardTarget: when the 64-moment walk finds nothing, it bisects the agent's
// request-opening index and then steps back through every opening, one by one, skipping each whose
// request the replayed state no longer holds (it was merged away). With many openings merged into
// one early retained request, every head change visits all of them. Work is counted as the number
// of distinct moment objects whose fields are read, never as wall-clock time.
describe("recordedCardTarget merged openings", () => {
  function tracked(touched: Set<number>, sequence: number, agentId: string, requestId?: string) {
    const seen = <T>(value: T): T => {
      touched.add(sequence);
      return value;
    };
    const out = {} as { sequence: number; agentId: string | undefined; requestId?: string };
    Object.defineProperty(out, "sequence", {
      enumerable: true,
      get: () => seen(sequence),
    });
    Object.defineProperty(out, "agentId", {
      enumerable: true,
      get: () => seen(agentId),
    });
    Object.defineProperty(out, "requestId", {
      enumerable: true,
      get: () => seen(requestId),
    });
    return out;
  }

  it("visits a bounded number of moments per head change with many merged-away openings", () => {
    const MERGED = 20_000;
    const touched = new Set<number>();
    const mergedIds = Array.from({ length: MERGED }, (_, i) => `r-merged-${i}`);
    const moments = [tracked(touched, 5, ADA, "r-early")];
    mergedIds.forEach((id, i) => {
      moments.push(tracked(touched, 10 + i, ADA, id)); // same agent, merged into r-early
    });
    const last = 10 + MERGED - 1;
    // Another agent's openings interleave and are retained, so they must not be returned for ADA.
    const bea = Array.from({ length: 50 }, (_, i) => `b-${i}`);
    bea.forEach((id, i) => {
      moments.push(tracked(touched, last + 1 + i, BEA, id));
    });
    const retained = [
      request("r-early", ADA, { mergedRequestIds: mergedIds }),
      ...bea.map((id) => request(id, BEA)),
    ];
    const call = (head: number) =>
      recordedCardTarget({ state: stateWith(head, retained), moments, selectedId: ADA });

    call(15_000); // warm-up: building a per-list index on first use is allowed
    for (const head of [last + 50, last, 15_000, 10_000, 5_000, 7]) {
      touched.clear();
      expect(call(head)?.requestId).toBe("r-early");
      expect(touched.size).toBeLessThan(200);
    }
    touched.clear();
    expect(call(4)).toBeNull(); // not yet opened at an earlier head
    expect(touched.size).toBeLessThan(200);
  });

  // Correctness guard (passes today, must keep passing): merged-away openings are never targets,
  // even when newer than every retained one; the answer is the latest retained opening at or
  // before the head, exactly as before. A merged-away opening does not redirect to its host
  // request when a different retained request opened later.
  it("matches the brute-force result on every head of a log with merged-away openings", () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const moments: ReturnType<typeof moment>[] = [];
    const all: Request[] = [];
    const hostByAgent = new Map<string, Request>();
    for (let seq = 1; seq <= 400; seq += 1) {
      const agent = next(2) === 0 ? ADA : BEA;
      const kind = next(5);
      if (kind === 0) {
        moments.push(moment(seq, agent)); // no request
      } else if (kind <= 2 || !hostByAgent.has(agent)) {
        const r = request(`r-${seq}`, agent);
        all.push(r);
        hostByAgent.set(agent, r);
        moments.push(moment(seq, agent, r.id));
      } else {
        const host = hostByAgent.get(agent) as Request;
        const id = `m-${seq}`; // merged into an earlier retained request, absent from the state
        (host.mergedRequestIds as string[]).push(id);
        moments.push(moment(seq, agent, id));
      }
    }
    const oracle = (head: number, agentId: string) => {
      for (let i = moments.length - 1; i >= 0; i -= 1) {
        const m = moments[i];
        if (m === undefined || m.sequence > head || m.agentId !== agentId) continue;
        if (m.requestId === undefined) continue;
        const r = all.find((x) => x.id === m.requestId);
        if (r !== undefined && r.agentId === agentId) return r.id;
      }
      return null;
    };
    for (let head = 0; head <= 400; head += 1) {
      const present = all.filter((r) => Number(r.id.slice(2)) <= head);
      for (const agentId of [ADA, BEA]) {
        const got = recordedCardTarget({
          state: stateWith(head, present),
          moments,
          selectedId: agentId,
        });
        expect(got?.requestId ?? null).toBe(oracle(head, agentId));
      }
    }
  });

  it("keeps the later retained request when an older host absorbed a newer opening", () => {
    const state = stateWith(3, [
      request("r-1", ADA, { mergedRequestIds: ["m-3"] }),
      request("r-2", ADA),
    ]);
    const moments = [moment(1, ADA, "r-1"), moment(2, ADA, "r-2"), moment(3, ADA, "m-3")];
    expect(recordedCardTarget({ state, moments, selectedId: ADA })?.requestId).toBe("r-2");
  });

  // Identity keying (second Scope bullet): a different array of the same length is a different
  // recording and must not reuse the first one's index.
  it("does not reuse an index across distinct moments arrays of equal length", () => {
    const a = [moment(1, ADA, "r-a")];
    const b = [moment(1, ADA, "r-b")];
    const state = stateWith(1, [request("r-a", ADA), request("r-b", ADA)]);
    expect(recordedCardTarget({ state, moments: a, selectedId: ADA })?.requestId).toBe("r-a");
    expect(recordedCardTarget({ state, moments: b, selectedId: ADA })?.requestId).toBe("r-b");
  });
});
