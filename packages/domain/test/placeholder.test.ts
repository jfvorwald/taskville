import fc from "fast-check";
import { describe, expect, it } from "vitest";

// Placeholder so the quality gate runs a real test in this package from day one,
// and proves fast-check is available for reducer property tests.
// Delete it when the package gets its first real test.
describe("@taskville/domain placeholder", () => {
  it("runs a fast-check property", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (xs) => {
        expect([...xs].reverse().reverse()).toEqual(xs);
      }),
    );
  });
});
