import { describe, expect, it } from "vitest";
import { attentionPulse } from "../../../../src/city/attention/pulse.ts";
import { crewBotTint } from "../../../../src/city/crew/subagents/tint.ts";
import type { Attention } from "../../../../src/data/domain.ts";

// A subagent is drawn only as a crew bot (M5.02), so the bot must carry the attention signal a
// block agent would have: red for needs-you, amber for trouble, nothing for waiting. The hue is
// the one `attentionPulse` gives a block agent, so the two cannot drift apart.
//
// `crewBotTint(agent, attention)` is the pure seam: it picks the hue for one subagent from the
// store's attention records (most urgent first, as `buildModels` reads them). The crew layer
// applies it to the bot's body and trim material (or any glow it likes); the layer itself is not
// unit-testable.

const T = "2026-10-31T10:00:00.000Z";

const record = (agentId: string, level: Attention["level"], kind: string): Attention =>
  ({ agentId, level, kind, since: T, heuristic: false }) as Attention;

const hueOf = (level: "needs_you" | "trouble") =>
  attentionPulse(level, { elapsedMs: 0, reducedMotion: true }).hue;

describe("crewBotTint", () => {
  it("tints a subagent that needs you with the red a block agent gets", () => {
    const tint = crewBotTint({ id: "kid" }, [record("kid", "needs_you", "permission")]);
    expect(tint).toMatchObject({ level: "needs_you", hue: "red" });
    expect(tint?.hue).toBe(hueOf("needs_you"));
  });

  it("tints a subagent in trouble amber", () => {
    const tint = crewBotTint({ id: "kid" }, [record("kid", "trouble", "silent")]);
    expect(tint).toMatchObject({ level: "trouble", hue: "amber" });
    expect(tint?.hue).toBe(hueOf("trouble"));
  });

  it("uses the most urgent record of the subagent, which comes first", () => {
    const tint = crewBotTint({ id: "kid" }, [
      record("kid", "needs_you", "permission"),
      record("kid", "waiting", "turn_ended"),
    ]);
    expect(tint?.level).toBe("needs_you");
  });

  it("ignores the records of other agents", () => {
    const tint = crewBotTint({ id: "kid" }, [
      record("other", "needs_you", "permission"),
      record("kid", "trouble", "silent"),
    ]);
    expect(tint?.level).toBe("trouble");
  });

  it("does not tint a waiting subagent, as a block agent gets no ring for waiting", () => {
    expect(crewBotTint({ id: "kid" }, [record("kid", "waiting", "turn_ended")])).toBeUndefined();
  });

  it("does not tint a subagent with no record", () => {
    expect(crewBotTint({ id: "kid" }, [])).toBeUndefined();
    expect(
      crewBotTint({ id: "kid" }, [record("other", "needs_you", "permission")]),
    ).toBeUndefined();
  });
});
