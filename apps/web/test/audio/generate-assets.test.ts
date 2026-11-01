import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The ambient loops are generated (src/audio/generate-assets.ts, see ASSETS.md) and the WAV files
// are committed. This pins that the generator is deterministic and that the committed files are
// exactly what it builds, so a change to the generator that is not re-run (or a stray hand edit
// of a WAV) fails here.
//
// Contract for the generator module: export `buildLoopWav(themeId: string): Buffer`, the pure
// builder that returns one loop's WAV bytes, and write the files to disk only when the module is
// run as a script (importing it must not touch the committed files).
//
// Byte-exactness depends on Math.sin and Math.exp, which the JS engine implements. The committed
// files were generated and verified with Node v26.8.2 (V8). If an engine upgrade ever changes
// them, regenerate with `node apps/web/src/audio/generate-assets.ts` and commit the new WAVs.

const THEMES = ["cyberpunk", "steampunk", "solarpunk", "aero"];
const wavUrl = (theme: string) => new URL(`../../src/audio/ambient-${theme}.wav`, import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("ambient loop generator", () => {
  it("is importable without rewriting the committed loops", async () => {
    const before = THEMES.map((t) => statSync(wavUrl(t)).mtimeMs);
    await import("../../src/audio/generate-assets.ts");
    const after = THEMES.map((t) => statSync(wavUrl(t)).mtimeMs);
    expect(after).toEqual(before);
  });

  it.each(THEMES)("builds the %s loop to identical bytes every time", async (theme) => {
    const { buildLoopWav } = await import("../../src/audio/generate-assets.ts");
    expect(typeof buildLoopWav).toBe("function");
    const first = buildLoopWav(theme);
    const second = buildLoopWav(theme);
    expect(sha256(first)).toBe(sha256(second));
    expect(first.length).toBe(second.length);
  });

  it.each(THEMES)("commits ambient-%s.wav exactly as the generator builds it", async (theme) => {
    const { buildLoopWav } = await import("../../src/audio/generate-assets.ts");
    const built = buildLoopWav(theme);
    expect(built.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(sha256(readFileSync(wavUrl(theme)))).toBe(sha256(built));
  });

  it("gives each theme its own loop", async () => {
    const { buildLoopWav } = await import("../../src/audio/generate-assets.ts");
    const hashes = THEMES.map((t) => sha256(buildLoopWav(t)));
    expect(new Set(hashes).size).toBe(THEMES.length);
  });
});
