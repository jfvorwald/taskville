import { describe, expect, it } from "vitest";
import { createTranscriptMapper } from "../../../src/claude-code/transcripts/index.ts";
import { assistantText, SESSION, T, userPrompt } from "./fixtures.ts";

// M8.20 (issue #533, M8.18 security review F1 and F2): the mapper reports the raw cwd it used for
// each session.started, as `sessionCwd` on that line's result, so the importer can check every
// session where the cwd is used. API under test: LineResult.sessionCwd?: string. It is set only
// on the line whose events include a session.started that carries a workingDirectory, and it
// equals that event's workingDirectory.

const OTHER = "2f6c1d2e-0000-4000-8000-0000000000b2";
const map = (mapper: ReturnType<typeof createTranscriptMapper>, line: object | string, n: number) =>
  mapper.mapLine(typeof line === "string" ? line : JSON.stringify(line), n);

describe("sessionCwd on the line result", () => {
  it("reports the cwd of the line that starts a session, and only that line", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    const first = map(mapper, userPrompt("go", { ts: T(0), cwd: "/tmp/redacted/root" }), 1);
    const second = map(mapper, assistantText("ok", { ts: T(1), cwd: "/tmp/redacted/root" }), 2);
    const started = first.events.find((e) => e.type === "session.started");
    expect(started?.payload).toMatchObject({ workingDirectory: "/tmp/redacted/root" });
    expect((first as { sessionCwd?: string }).sessionCwd).toBe("/tmp/redacted/root");
    expect((second as { sessionCwd?: string }).sessionCwd).toBeUndefined();
  });

  it("reports the cwd of a later session in the same file", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    map(mapper, userPrompt("a", { ts: T(0), cwd: "/tmp/redacted/root", sessionId: SESSION }), 1);
    const later = map(
      mapper,
      userPrompt("b", { ts: T(1), cwd: "/tmp/redacted/outside", sessionId: OTHER }),
      2,
    );
    expect((later as { sessionCwd?: string }).sessionCwd).toBe("/tmp/redacted/outside");
  });

  it("reports the cwd of a line that spells the key with an escape", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    const raw = JSON.stringify(userPrompt("a", { ts: T(0), cwd: "/tmp/redacted/outside" })).replace(
      '"cwd"',
      '"\\u0063wd"',
    );
    expect(raw).not.toContain('"cwd"');
    const result = map(mapper, raw, 1);
    expect((result as { sessionCwd?: string }).sessionCwd).toBe("/tmp/redacted/outside");
  });
});

// M8.20 review fixes (roborev 7782, security L1). API under test: LineResult.cwd is the first cwd
// of any line that parses as a JSON object, even when the record is malformed; sessionCwd equals
// the emitted workingDirectory (the cleaned, cut value), never the raw cwd.
describe("review findings", () => {
  it("reports the cwd of a valid JSON line of an unsupported type", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    const result = map(
      mapper,
      { type: "unsupported-kind", cwd: "/tmp/redacted/outside", sessionId: SESSION },
      1,
    );
    expect(result.outcome).toBe("malformed");
    expect(result.cwd).toBe("/tmp/redacted/outside");
  });

  it("reports a cwd only for a line that parses as a JSON object", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    expect(map(mapper, "[1]", 1).cwd).toBeUndefined();
    expect(map(mapper, "not json", 2).cwd).toBeUndefined();
  });

  it("sessionCwd equals the emitted workingDirectory for an over-long cwd", () => {
    const mapper = createTranscriptMapper({ projectId: "proj-1", fileId: "f" });
    const long = `/tmp/redacted/outside/${"a/".repeat(2_100)}${"../".repeat(2_100)}../root`;
    const result = map(mapper, userPrompt("go", { ts: T(0), cwd: long }), 1);
    const started = result.events.find((e) => e.type === "session.started");
    const emitted = (started?.payload as { workingDirectory?: string } | undefined)
      ?.workingDirectory;
    expect(emitted).toBeDefined();
    expect((result as { sessionCwd?: string }).sessionCwd).toBe(emitted);
  });
});
