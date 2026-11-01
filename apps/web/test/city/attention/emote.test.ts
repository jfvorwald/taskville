import { describe, expect, it } from "vitest";
import { attentionEmote } from "../../../src/city/attention/emote.ts";

// Emotes are small billboard icons (ARCHITECTURE.md 2.3): "!", "?", "...", sweat drop, "zzz".
// The level picks the family; the kind picks within it.

type Input = NonNullable<Parameters<typeof attentionEmote>[0]>;

const KINDS: Record<Input["level"], readonly string[]> = {
  needs_you: ["permission", "elicitation", "input"],
  trouble: ["stop_failure", "tool_failures", "silent"],
  waiting: ["turn_ended", "idle_prompt"],
};

describe("attentionEmote", () => {
  it("shows '!' for every needs-you kind", () => {
    for (const kind of KINDS.needs_you) {
      expect(attentionEmote({ level: "needs_you", kind } as Input)).toBe("!");
    }
  });

  it("shows a sweat drop for recorded trouble", () => {
    expect(attentionEmote({ level: "trouble", kind: "stop_failure" })).toBe("sweat");
    expect(attentionEmote({ level: "trouble", kind: "tool_failures" })).toBe("sweat");
  });

  it("shows '?' for heuristic silent trouble, which is a guess", () => {
    expect(attentionEmote({ level: "trouble", kind: "silent" })).toBe("?");
  });

  it("shows 'zzz' for an idle prompt and '...' for a turn that ended", () => {
    expect(attentionEmote({ level: "waiting", kind: "idle_prompt" })).toBe("zzz");
    expect(attentionEmote({ level: "waiting", kind: "turn_ended" })).toBe("...");
  });

  it("shows nothing when there is no attention record", () => {
    expect(attentionEmote(undefined)).toBeNull();
  });

  it("gives every kind of every level an emote", () => {
    for (const [level, kinds] of Object.entries(KINDS)) {
      for (const kind of kinds) {
        expect(attentionEmote({ level, kind } as Input)).not.toBeNull();
      }
    }
  });
});
