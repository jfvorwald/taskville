import { describe, expect, it } from "vitest";
import {
  currentFile,
  elapsedMs,
  formatElapsed,
} from "../../../../src/overlays/agent-panel/shell/facts.ts";

// M5.05 (ARCHITECTURE.md 2.10, constitution IV): the header facts, computed and never invented.
//
// Contract pinned here (pure, `shell/facts.ts`):
//   elapsedMs({ firstSeenAt, finishedAt? }, nowMs): number | null
//     since the agent was first seen, up to `nowMs` (the injected clock) while it is running and
//     up to `finishedAt` once finished, so a finished agent's time stops. Never negative.
//     null when a timestamp cannot be parsed.
//   formatElapsed(ms): string        "45s", "2m 5s", "1h 2m"; "0s" for negative or non-finite
//   currentFile(agentId, toolCalls): string | null
//     the first of `filePaths` of that agent's newest (highest `startSeq`) call whose phase is
//     "running"; null when that call names no file, or when nothing is running. A finished call
//     is not "right now", and an older running call is not promoted past a newer one.

const T0 = Date.parse("2026-11-01T12:00:00.000Z");

describe("elapsedMs", () => {
  it("runs up to the injected clock while the agent has not finished", () => {
    const agent = { firstSeenAt: new Date(T0).toISOString() };
    expect(elapsedMs(agent, T0 + 125_000)).toBe(125_000);
  });

  it("stops at finishedAt once the agent is done", () => {
    const agent = {
      firstSeenAt: new Date(T0).toISOString(),
      finishedAt: new Date(T0 + 30_000).toISOString(),
    };
    expect(elapsedMs(agent, T0 + 999_000)).toBe(30_000);
  });

  it("is never negative (clock skew)", () => {
    expect(elapsedMs({ firstSeenAt: new Date(T0).toISOString() }, T0 - 5_000)).toBe(0);
  });

  it("is null when a timestamp is not a date", () => {
    expect(elapsedMs({ firstSeenAt: "not a date" }, T0)).toBeNull();
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [60_000, "1m 0s"],
    [125_000, "2m 5s"],
    [3_725_000, "1h 2m"],
    [-1, "0s"],
    [Number.NaN, "0s"],
  ])("%s ms is %s", (ms, label) => {
    expect(formatElapsed(ms)).toBe(label);
  });
});

type Call = Parameters<typeof currentFile>[1][string];
const call = (over: Partial<Call> & { id: string; agentId: string; startSeq: number }): Call =>
  ({ phase: "running", filePaths: [], evidenceIds: [], ...over }) as Call;

describe("currentFile", () => {
  it("is the file of the agent's newest running call", () => {
    const calls = {
      c1: call({ id: "c1", agentId: "a", startSeq: 1, filePaths: ["src/old.ts"] }),
      c2: call({ id: "c2", agentId: "a", startSeq: 2, filePaths: ["src/new.ts", "src/x.ts"] }),
    };
    expect(currentFile("a", calls)).toBe("src/new.ts");
  });

  it("ignores other agents' calls", () => {
    const calls = {
      c1: call({ id: "c1", agentId: "b", startSeq: 5, filePaths: ["src/theirs.ts"] }),
      c2: call({ id: "c2", agentId: "a", startSeq: 1, filePaths: ["src/mine.ts"] }),
    };
    expect(currentFile("a", calls)).toBe("src/mine.ts");
  });

  it("is null when the call has finished (not touched right now)", () => {
    const calls = {
      c1: call({ id: "c1", agentId: "a", startSeq: 1, phase: "succeeded", filePaths: ["f.ts"] }),
      c2: call({ id: "c2", agentId: "a", startSeq: 2, phase: "failed", filePaths: ["g.ts"] }),
      c3: call({ id: "c3", agentId: "a", startSeq: 3, phase: "unfinished", filePaths: ["h.ts"] }),
    };
    expect(currentFile("a", calls)).toBeNull();
  });

  it("is null when the newest running call names no file, not an older call's file", () => {
    const calls = {
      c1: call({ id: "c1", agentId: "a", startSeq: 1, filePaths: ["src/old.ts"] }),
      c2: call({ id: "c2", agentId: "a", startSeq: 2, toolName: "Bash", filePaths: [] }),
    };
    expect(currentFile("a", calls)).toBeNull();
  });

  it("is null when the agent has no calls", () => {
    expect(currentFile("a", {})).toBeNull();
  });
});
