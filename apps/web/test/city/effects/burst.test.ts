import { describe, expect, it } from "vitest";
import { createBurst } from "../../../src/city/effects/burst.ts";

// The e2e check matches screenshot pixels against the palette in Celebrations.tsx, so the burst
// materials must draw those exact colors: no ACES tone mapping from the renderer.
describe("burst material", () => {
  it("is not tone mapped, so particles draw in their exact palette colors", () => {
    const burst = createBurst({
      capacity: 8,
      lifetimeMs: 1000,
      speed: 2,
      size: 0.1,
      gravity: 5,
      colors: ["#ffd166", "#fff3b0"],
    });
    const material = burst.mesh.material;
    expect(Array.isArray(material)).toBe(false);
    expect((material as { toneMapped: boolean }).toneMapped).toBe(false);
    burst.dispose();
  });
});
