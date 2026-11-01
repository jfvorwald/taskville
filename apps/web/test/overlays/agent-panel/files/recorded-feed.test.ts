import { describe, expect, it } from "vitest";
import {
  PARALLEL,
  SPIKE_CWD,
  useHarness as setupHarness,
  toolCallFrames,
} from "../../../../../engine/test/feed/helpers.ts";
import recorded from "../../../../src/overlays/agent-panel/files/recorded-feed.fixture.json";

// This fixture was captured from the real M5.01 ToolCallTracker and evidence route after
// ingesting fixtures/claude-code/subagent/parallel.jsonl. Only the ingest clock is synthetic.
// Keep this passing provenance check beside the red component contract: an invented wire
// shape must never be the reason the Files implementation fails.
const start = setupHarness();

describe("M5.07 recorded Files feed fixture", () => {
  it("matches the existing feed and evidence APIs for the S-2 parallel recording", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(PARALLEL.file);
    for (const agent of [PARALLEL.lead, PARALLEL.a, PARALLEL.b]) {
      const expected = recorded.frames.filter((f) => f.data.agentId === agent);
      const reader = await h.openFeed(agent);
      try {
        const actual = await toolCallFrames(reader, expected.length);
        expect(actual).toEqual(expected);
      } finally {
        await reader.cancel();
      }
    }
    for (const [id, expected] of Object.entries(recorded.evidence)) {
      const response = await h.evidenceBody(id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    expect(recorded.frames.some((f) => f.data.toolName === "Edit")).toBe(true);
    expect(recorded.frames.some((f) => f.data.toolName === "Write")).toBe(true);
  });
});
