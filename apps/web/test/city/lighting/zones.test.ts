import { describe, expect, it } from "vitest";
import { createLightingController } from "../../../src/city/lighting/controller.ts";
import type { LightingPhase } from "../../../src/city/lighting/phase.ts";
import { createThemeController } from "../../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";

// Phase boundaries (phase.ts): dawn 05:30, day 07:30, dusk 17:30, night 19:30, local time.
// Offsets are fixed for 2026-10-31: Kolkata +05:30, New York EDT -04:00, Auckland NZDT +13:00.
const ZONES = [
  { zone: "Asia/Kolkata", offsetMin: 5.5 * 60 },
  { zone: "America/New_York", offsetMin: -4 * 60 },
  { zone: "Pacific/Auckland", offsetMin: 13 * 60 },
] as const;

// [local time, phase just before, phase at the boundary]
const BOUNDARIES: ReadonlyArray<[string, LightingPhase, string, LightingPhase]> = [
  ["05:29", "night", "05:30", "dawn"],
  ["07:29", "dawn", "07:30", "day"],
  ["17:29", "day", "17:30", "dusk"],
  ["19:29", "dusk", "19:30", "night"],
];

/** The instant that reads `hhmm` on 2026-10-31 in a zone with a fixed UTC offset. */
function instantAt(hhmm: string, offsetMin: number): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return Date.UTC(2026, 9, 31, h, m) - offsetMin * 60_000;
}

function phaseIn(instant: number, timeZone: string) {
  const theme = createThemeController({ themes: [cyberpunkTheme] });
  const lighting = createLightingController({ theme, now: () => instant, timeZone });
  return { phase: lighting.state().phase, mode: theme.store.getState().mode };
}

describe("phase boundaries through the controller, by zone", () => {
  for (const { zone, offsetMin } of ZONES) {
    describe(zone, () => {
      for (const [before, phaseBefore, at, phaseAt] of BOUNDARIES) {
        it(`${before} is ${phaseBefore} and ${at} is ${phaseAt}`, () => {
          expect(phaseIn(instantAt(before, offsetMin), zone).phase).toBe(phaseBefore);
          expect(phaseIn(instantAt(at, offsetMin), zone).phase).toBe(phaseAt);
        });
      }

      it("is in day mode at local noon and night mode at local midnight", () => {
        expect(phaseIn(instantAt("12:00", offsetMin), zone).mode).toBe("day");
        expect(phaseIn(instantAt("00:00", offsetMin), zone).mode).toBe("night");
      });
    });
  }

  it("uses the zone's offset on the day daylight saving ends (New York, 2026-11-01)", () => {
    // Clocks went back at 06:00Z, so 22:30Z is 17:30 EST (UTC-5), not 18:30 EDT.
    const zone = "America/New_York";
    expect(phaseIn(Date.parse("2026-11-01T22:30:00Z"), zone).phase).toBe("dusk");
    expect(phaseIn(Date.parse("2026-11-01T22:29:00Z"), zone).phase).toBe("day");
  });
});
