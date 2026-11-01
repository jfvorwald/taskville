import type { Attention } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommittedBatch } from "../../src/ingest/index.ts";
import { domainReducer } from "../../src/ingest/index.ts";
import type { Storage } from "../../src/storage/index.ts";
import {
  AttentionFeed,
  type AttentionFrame,
  type AttentionListener,
} from "../../src/stream/attention.ts";

// M4.01 review fixes at the AttentionFeed level, with the domain selector replaced by a list the
// test sets, so the exact records (and their order and odd IDs) are under its control:
//
// - roborev 5836: "did the set change" compares records structurally. IDs are opaque strings and
//   may contain any character, so no separator can make two different sets look equal; a pure
//   reorder of the same members is not a change.
// - code review S3 and security L3: a storage or replay failure during the timer tick or during
//   `publish` neither propagates nor stops the feed; later frames still arrive.
// - nit 10: `close()` clears the tick timer; two listeners both get a change.

const records = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@taskville/domain/selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@taskville/domain/selectors")>()),
  attention: () => records.current,
}));

const T = "2026-10-30T11:00:00.000Z";
const rec = (
  agentId: string,
  requestId: string | undefined,
  level: "needs_you" | "trouble" = "needs_you",
  kind: string = level === "needs_you" ? "permission" : "stop_failure",
): Attention =>
  ({
    agentId,
    level,
    kind,
    since: T,
    ...(requestId === undefined ? {} : { requestId }),
    heuristic: false,
  }) as Attention;

const set = (...next: Attention[]) => {
  records.current = next;
};

const batch = (projectId = "alpha"): CommittedBatch => ({ events: [], heads: { [projectId]: 2 } });

/** The fields of a record written out joined by NUL, as the roborev 5836 collision does. */
const encoded = (r: Attention) =>
  `${r.agentId}\u0000${r.level}\u0000${r.kind}\u0000${r.requestId ?? ""}`;

let failing: "projects" | "projection" | undefined;
let projectsCalls = 0;
const storage = {
  projects: () => {
    projectsCalls += 1;
    if (failing === "projects") throw new Error("disk I/O error");
    return [{ id: "alpha", name: "Alpha" }];
  },
  projection: () => {
    if (failing === "projection") throw new Error("projection unreadable");
    return { reducerVersion: domainReducer.version, head: 1, state: {} };
  },
  head: () => 1,
  events: () => [],
} as unknown as Storage;

const NOW = new Date("2026-10-30T11:01:00Z");

let feed: AttentionFeed | undefined;
afterEach(() => {
  feed?.close();
  feed = undefined;
  vi.useRealTimers();
  set();
  failing = undefined;
  projectsCalls = 0;
});

function listener() {
  const frames: AttentionFrame[] = [];
  const l: AttentionListener = { offer: (f) => frames.push(f) };
  return { frames, l };
}

/** A feed with one subscribed listener whose snapshot (the first frame) is already taken. */
function started(initial: Attention[], tickMs = 1_000_000) {
  set(...initial);
  feed = new AttentionFeed({ storage, now: () => NOW, tickMs });
  const { frames, l } = listener();
  feed.subscribe(l);
  expect(frames.map((f) => f.event)).toEqual(["snapshot"]);
  frames.length = 0;
  return { feed, frames };
}

describe("comparing record sets", () => {
  it("sends a frame when two needs-you records are replaced by one whose request ID spells out the other (roborev 5836)", () => {
    const a1 = rec("agent-1", "r1");
    const a2 = rec("agent-2", "r2");
    const crafted = rec("agent-1", `r1\u0001${encoded(a2)}`);
    const { feed: f, frames } = started([a1, a2]);

    set(crafted);
    f.publish(batch());

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      event: "attention",
      data: { projectId: "alpha", attention: [crafted] },
    });
  });

  it("sends a frame when an agent ID carries the separators and swallows the next record", () => {
    const a1 = rec("a", "r");
    const a2 = rec("b", "s");
    const crafted = rec(`${encoded(a1)}\u0001b`, "s");
    const { feed: f, frames } = started([a1, a2]);

    set(crafted);
    f.publish(batch());

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: "attention", data: { attention: [crafted] } });
  });

  it("sends a frame when only the membership changes, and none when nothing does", () => {
    const { feed: f, frames } = started([rec("agent-1", "r1")]);
    f.publish(batch());
    expect(frames).toHaveLength(0);

    set(rec("agent-1", "r1"), rec("agent-2", "r2"));
    f.publish(batch());
    expect(frames).toHaveLength(1);
  });

  it("sends nothing for a pure reorder of the same records (nit 6)", () => {
    const a1 = rec("agent-1", "r1");
    const a2 = rec("agent-2", "r2");
    const t1 = rec("agent-3", undefined, "trouble");
    const { feed: f, frames } = started([a1, a2, t1]);

    set(t1, a2, a1);
    f.publish(batch());
    expect(frames).toHaveLength(0);

    // The reorder did not lose track of the set: a real change after it is still announced.
    set(t1, a2);
    f.publish(batch());
    expect(frames).toHaveLength(1);
  });
});

describe("a storage failure does not stop the feed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  it.each(["projects", "projection"] as const)(
    "survives %s throwing on the timer tick and delivers later frames (S3)",
    (mode) => {
      const { frames } = started([rec("agent-1", "r1")], 1000);

      failing = mode;
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(frames).toHaveLength(0);

      failing = undefined;
      set(rec("agent-1", "r1"), rec("agent-2", "r2"));
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ event: "attention", data: { projectId: "alpha" } });
    },
  );

  it.each(["projects", "projection"] as const)(
    "survives %s throwing in publish and delivers later frames (L3)",
    (mode) => {
      const { feed: f, frames } = started([rec("agent-1", "r1")]);

      failing = mode;
      expect(() => f.publish(batch())).not.toThrow();
      expect(frames).toHaveLength(0);

      failing = undefined;
      set();
      expect(() => f.publish(batch())).not.toThrow();
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ event: "attention", data: { attention: [] } });
    },
  );
});

describe("lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  it("close() clears the tick timer, so nothing runs after it (nit 10)", () => {
    const { feed: f } = started([rec("agent-1", "r1")], 1000);
    expect(vi.getTimerCount()).toBe(1);

    f.close();
    expect(vi.getTimerCount()).toBe(0);
    const before = projectsCalls;
    vi.advanceTimersByTime(10_000);
    expect(projectsCalls).toBe(before);
  });

  it("gives a change to every open listener", () => {
    const { feed: f, frames: first } = started([rec("agent-1", "r1")]);
    const second = listener();
    f.subscribe(second.l);
    second.frames.length = 0;

    set();
    f.publish(batch());

    expect(first.map((x) => x.event)).toEqual(["attention"]);
    expect(second.frames.map((x) => x.event)).toEqual(["attention"]);
  });
});
