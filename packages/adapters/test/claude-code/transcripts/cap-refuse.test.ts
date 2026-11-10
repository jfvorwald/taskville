import { describe, expect, it } from "vitest";
import { createTranscriptMapper } from "../../../src/claude-code/transcripts/index.ts";
import { assistantToolUse, T, userPrompt } from "./fixtures.ts";

// M8.18 (issue #529, M8.10 security review L2). At the 50_000 `sessions` cap a hostile file must
// not make an existing session emit `agent.registered` or `session.started` again, and must not
// make a registered subagent register again. Either a new session is refused at the cap (that
// line is malformed) or a seen flag survives eviction: both satisfy these tests. No credential
// data is used.

const N = 60_000;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPAWN_UUID = "00000000-0000-4000-8000-0000000000cc";
const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("the sessions cap does not let an existing session register again", () => {
  it("emits neither agent.registered nor session.started for a known session at the cap", () => {
    const m = createTranscriptMapper({ projectId: "proj-1" });
    m.mapLine(JSON.stringify(userPrompt("first", { ts: T(0), sessionId: A, cwd: "/w/app" })), 1);
    for (let i = 0; i < N; i += 1) {
      const sessionId = `s${i}`;
      m.mapLine(JSON.stringify(userPrompt("hi", { ts: T(1), sessionId })), i + 2);
    }
    // The hostile line names the same session with a different cwd.
    const r = m.mapLine(
      JSON.stringify(userPrompt("again", { ts: T(2), sessionId: A, cwd: "/elsewhere" })),
      N + 2,
    );
    expect(types(r.events)).not.toContain("agent.registered");
    expect(types(r.events)).not.toContain("session.started");
  }, 60_000);

  it("does not register a registered subagent again after the cap is passed", () => {
    const m = createTranscriptMapper({ projectId: "proj-1" });
    m.mapLine(
      JSON.stringify(
        assistantToolUse("toolu_AG", "Agent", {}, { ts: T(0), sessionId: A, uuid: SPAWN_UUID }),
      ),
      1,
    );
    const sub = {
      ts: T(1),
      sessionId: A,
      sidechain: true,
      agentId: "agent-sub",
      parentUuid: SPAWN_UUID,
    };
    const first = m.mapLine(JSON.stringify(assistantToolUse("toolu_S1", "Read", {}, sub)), 2);
    expect(types(first.events)).toContain("agent.registered");
    for (let i = 0; i < N; i += 1) {
      const sessionId = `s${i}`;
      m.mapLine(JSON.stringify(userPrompt("hi", { ts: T(2), sessionId })), i + 3);
    }
    const again = m.mapLine(
      JSON.stringify(assistantToolUse("toolu_S2", "Read", {}, { ...sub, ts: T(3) })),
      N + 3,
    );
    expect(types(again.events)).not.toContain("agent.registered");
  }, 60_000);

  it("refuses or ignores a new session past the cap without evicting an old one", () => {
    const m = createTranscriptMapper({ projectId: "proj-1" });
    for (let i = 0; i < N; i += 1) {
      m.mapLine(JSON.stringify(userPrompt("hi", { ts: T(0), sessionId: `s${i}` })), i + 1);
    }
    // The first session still counts as seen: its next line is not a registration.
    const r = m.mapLine(JSON.stringify(userPrompt("again", { ts: T(1), sessionId: "s0" })), N + 1);
    expect(types(r.events)).not.toContain("agent.registered");
    expect(types(r.events)).not.toContain("session.started");
  }, 60_000);
});
