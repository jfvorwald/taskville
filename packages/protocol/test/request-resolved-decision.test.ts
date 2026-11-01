import { describe, expect, it } from "vitest";
import { storedPayloadSchemas } from "../src/index.ts";

// M4.02 (decision #116 D2 and D3): a request the engine closes from a terminal answer records
// which way the user answered, as one optional, additive field.
describe("request.resolved decision", () => {
  const schema = storedPayloadSchemas["request.resolved"];

  it("accepts allow and deny next to the resolution", () => {
    for (const decision of ["allow", "deny"]) {
      const parsed = schema.safeParse({
        requestId: "req-1",
        resolution: "answered_elsewhere",
        decision,
      });
      expect(parsed.success, decision).toBe(true);
    }
  });

  it("stays optional, so existing events keep validating", () => {
    expect(schema.safeParse({ requestId: "req-1", resolution: "answered_here" }).success).toBe(
      true,
    );
  });

  it("rejects any other value", () => {
    for (const decision of ["maybe", "", "ALLOW", null, true]) {
      const parsed = schema.safeParse({
        requestId: "req-1",
        resolution: "answered_elsewhere",
        decision,
      });
      expect(parsed.success, String(decision)).toBe(false);
    }
  });
});
