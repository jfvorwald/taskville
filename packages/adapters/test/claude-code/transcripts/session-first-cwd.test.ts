import { describe, expect, it } from "vitest";
import { createTranscriptMapper } from "../../../src/claude-code/transcripts/index.ts";
import { assistantText, SESSION, T, userPrompt } from "./fixtures.ts";

// M8.21 (issue #537, M8.20 security review L2). API under test: LineResult.sessionFirstCwd?:
// string, the raw cwd of the first line of a session that carries one, reported only when that
// session registered without a cwd (its session.started was `{}`). It is set on that one line
// and never again for the session, so the importer can check it without checking every line.

const OTHER = "2f6c1d2e-0000-4000-8000-0000000000b2";
type Result = { sessionFirstCwd?: string };
const map = (mapper: ReturnType<typeof createTranscriptMapper>, line: object, n: number) =>
  mapper.mapLine(JSON.stringify(line), n) as ReturnType<typeof mapper.mapLine> & Result;

describe("sessionFirstCwd on the line result", () => {
  it("reports the first cwd of a session that registered without one, on that line only", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    const first = map(mapper, userPrompt("a", { ts: T(0), cwd: null }), 1);
    const second = map(mapper, assistantText("b", { ts: T(1), cwd: "/tmp/redacted/outside" }), 2);
    const third = map(mapper, assistantText("c", { ts: T(2), cwd: "/tmp/redacted/other" }), 3);
    expect(first.sessionFirstCwd).toBeUndefined();
    expect(second.sessionFirstCwd).toBe("/tmp/redacted/outside");
    expect(third.sessionFirstCwd).toBeUndefined();
  });

  it("does not report it for a session that registered with a cwd", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    const first = map(mapper, userPrompt("a", { ts: T(0), cwd: "/tmp/redacted/root" }), 1);
    const second = map(mapper, assistantText("b", { ts: T(1), cwd: "/tmp/redacted/sub" }), 2);
    expect(first.sessionFirstCwd).toBeUndefined();
    expect(second.sessionFirstCwd).toBeUndefined();
  });

  it("tracks each session on its own", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    map(mapper, userPrompt("a", { ts: T(0), cwd: "/tmp/redacted/root", sessionId: SESSION }), 1);
    map(mapper, userPrompt("b", { ts: T(1), cwd: null, sessionId: OTHER }), 2);
    const later = map(
      mapper,
      userPrompt("c", { ts: T(2), cwd: "/tmp/redacted/outside", sessionId: OTHER }),
      3,
    );
    expect(later.sessionFirstCwd).toBe("/tmp/redacted/outside");
  });
});
