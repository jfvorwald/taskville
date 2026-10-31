import { describe, expect, it } from "vitest";
import { attributeHook } from "../../../src/claude-code/crew/index.ts";

// Which agent a hook belongs to (S-2 "Subagent identity and parents", decision #120 D1).

const SESSION = "6effc000-1111-4222-8333-444455556666";

describe("attributeHook", () => {
  it("attributes a hook without agent_id to the session's own agent", () => {
    expect(attributeHook({ session_id: SESSION, hook_event_name: "Stop" })).toEqual({
      role: "session",
      sessionId: SESSION,
      agentId: `claude-code:${SESSION}`,
      sourceAgentId: SESSION,
    });
  });

  it("attributes a subagent hook to (session_id, agent_id)", () => {
    const hook = { session_id: SESSION, agent_id: "ac5497782768787b9", agent_type: "outer" };
    expect(attributeHook(hook)).toEqual({
      role: "subagent",
      sessionId: SESSION,
      agentId: `claude-code:${SESSION}:ac5497782768787b9`,
      sourceAgentId: "ac5497782768787b9",
      agentType: "outer",
    });
  });

  it("recognizes an in-process teammate by its a<name>-<16 hex> agent_id", () => {
    const hook = { session_id: SESSION, agent_id: "apip-5cb5e9bb3f2f1097", agent_type: "pip" };
    expect(attributeHook(hook)).toEqual({
      role: "teammate",
      sessionId: SESSION,
      agentId: `claude-code:${SESSION}:apip-5cb5e9bb3f2f1097`,
      sourceAgentId: "apip-5cb5e9bb3f2f1097",
      agentType: "pip",
    });
  });

  it("does not take a teammate-shaped id whose name differs from agent_type as a teammate", () => {
    const hook = { session_id: SESSION, agent_id: "apip-5cb5e9bb3f2f1097", agent_type: "bo" };
    expect(attributeHook(hook)?.role).toBe("subagent");
  });

  it("marks agents with an empty or missing agent_type as internal helpers", () => {
    for (const agent_type of ["", undefined]) {
      const hook = { session_id: SESSION, agent_id: "aaa4d3eee3b92d002", agent_type };
      expect(attributeHook(hook)?.role).toBe("helper");
    }
  });

  it("returns undefined without a usable session_id", () => {
    for (const session_id of [undefined, "", 7, "x".repeat(101), "has space", "a\u0000b"]) {
      expect(attributeHook({ session_id })).toBeUndefined();
    }
    expect(attributeHook(null)).toBeUndefined();
    expect(attributeHook([SESSION])).toBeUndefined();
    expect(attributeHook("session")).toBeUndefined();
  });

  it("returns undefined for an agent_id that is not a plain bounded token", () => {
    for (const agent_id of ["a".repeat(65), "a b", "a/../b", 12, "a\u{1F600}"]) {
      expect(attributeHook({ session_id: SESSION, agent_id, agent_type: "x" })).toBeUndefined();
    }
  });

  it("rejects an id the redaction rules would mask, since IDs are stored unmasked", () => {
    const agent_id = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    expect(attributeHook({ session_id: SESSION, agent_id, agent_type: "x" })).toBeUndefined();
  });

  it("reads only own properties, so a prototype cannot supply fields", () => {
    const hook = JSON.parse(
      `{"__proto__": {"session_id": "${SESSION}", "agent_id": "abc"}, "hook_event_name": "Stop"}`,
    );
    expect(attributeHook(hook)).toBeUndefined();
  });
});
