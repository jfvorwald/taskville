import { describe, expect, it } from "vitest";
import { attentionEmote, breakEmote } from "../../../src/city/attention/emote.ts";
import type { BreakActivity } from "../../../src/city/breaks/types.ts";

// While on break the "zzz" / "..." waiting emote is replaced by an activity emote (a puff, a mug,
// a sparkle). Needs-you and trouble emotes always win.

const ACTIVITIES: readonly BreakActivity[] = [
  "bar",
  "smoke",
  "stroll",
  "juggle",
  "stargaze",
  "pigeons",
];
const BREAK_KINDS: readonly string[] = ["puff", "mug", "sparkle", "note"];

describe("breakEmote", () => {
  it("gives every activity one of the break emotes", () => {
    for (const a of ACTIVITIES) expect(BREAK_KINDS).toContain(breakEmote(a));
  });

  it("shows a mug at the bar and a puff on a smoke break", () => {
    expect(breakEmote("bar")).toBe("mug");
    expect(breakEmote("smoke")).toBe("puff");
  });
});

describe("attentionEmote on break", () => {
  it("replaces zzz and '...' with the activity emote", () => {
    expect(attentionEmote({ level: "waiting", kind: "idle_prompt" }, "bar")).toBe("mug");
    expect(attentionEmote({ level: "waiting", kind: "turn_ended" }, "smoke")).toBe("puff");
  });

  it("keeps needs-you and trouble emotes over any break emote", () => {
    for (const a of ACTIVITIES) {
      expect(attentionEmote({ level: "needs_you", kind: "permission" }, a)).toBe("!");
      expect(attentionEmote({ level: "trouble", kind: "silent" }, a)).toBe("?");
      expect(attentionEmote({ level: "trouble", kind: "stop_failure" }, a)).toBe("sweat");
    }
  });

  it("is unchanged without a break", () => {
    expect(attentionEmote({ level: "waiting", kind: "idle_prompt" }, null)).toBe("zzz");
    expect(attentionEmote({ level: "waiting", kind: "turn_ended" })).toBe("...");
  });
});
