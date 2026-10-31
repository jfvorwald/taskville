import { describe, expect, it } from "vitest";
import { textProblem } from "../../src/ingest/text-check.ts";

describe("textProblem (security F2)", () => {
  it("reports a lone surrogate with its path", () => {
    expect(textProblem({ payload: { title: "a\ud800" } })).toEqual(
      expect.objectContaining({ code: "invalid_payload", path: "payload.title" }),
    );
    expect(textProblem({ agentId: "\udc00" })).toEqual(
      expect.objectContaining({ code: "invalid_envelope", path: "agentId" }),
    );
    expect(textProblem({ payload: { ok: ["fine"] } })).toBeUndefined();
  });

  it("turns a stack overflow on deep nesting into an invalid_payload rejection", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 1_000_000; i++) deep = [deep];
    expect(textProblem({ payload: { nested: deep } })).toEqual(
      expect.objectContaining({ code: "invalid_payload", path: "payload" }),
    );
  });
});
