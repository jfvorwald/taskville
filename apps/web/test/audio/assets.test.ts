import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Done-when for M4.09: "asset license file present". ARCHITECTURE 2.7: loops are under 500 KB each,
// bundled under a permissive license or self-made. Every audio file under apps/web/src/audio/
// needs a table row in ASSETS.md (file | source | license). The ambient loops are named
// ambient-<themeId>.<ext>, one per built-in theme.

const AUDIO_DIR = fileURLToPath(new URL("../../src/audio/", import.meta.url));
const ASSETS_MD = join(AUDIO_DIR, "ASSETS.md");
const EXTENSIONS = "mp3|ogg|oga|opus|wav|m4a|aac|flac|webm";
const AUDIO_EXT = new RegExp(`\\.(${EXTENSIONS})$`, "i");
const MAX_BYTES = 500 * 1000;
const THEMES = ["cyberpunk", "steampunk", "solarpunk", "aero"];
const KNOWN_LICENSE =
  /^(CC0|CC[- ]BY(?:[- ]SA)?(?:[- ]\d\.\d)?|MIT|Apache[- ]2\.0|ISC|BSD|public domain|self-made|original work)$/i;

function assetCells(row: string): string[] {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function hasKnownLicense(row: string): boolean {
  return KNOWN_LICENSE.test(assetCells(row)[2] ?? "");
}

describe("asset license validation", () => {
  it.each([
    "CC0",
    "CC-BY",
    "CC BY",
    "CC-BY-SA",
    "CC BY SA",
    "CC-BY-4.0",
    "CC-BY-SA-4.0",
    "CC BY 4.0",
    "MIT",
    "Apache-2.0",
    "Apache 2.0",
    "ISC",
    "BSD",
    "public domain",
    "self-made",
    "original work",
  ])("accepts the existing allowed identifier %s in the license cell", (license) => {
    expect(hasKnownLicense(`| ambient-fixture.wav | fixture source | ${license} |`)).toBe(true);
  });

  it.each([
    "CC-BY-NC",
    "CC-BY-NC-4.0",
    "CC-BY-NC-SA-4.0",
    "CC BY NC",
    "custom-MIT",
    "MIT-custom",
    "MITX",
    "XMIT",
    "CC0-extra",
    "extra-CC0",
    "BSD-like",
    "Apache-2.0-extra",
    "not MIT",
    "MIT OR unknown",
    "ΜIT",
    "CC‐BY",
    "unknown",
  ])("rejects the non-identifier license cell %s", (license) => {
    expect(hasKnownLicense(`| ambient-fixture.wav | fixture source | ${license} |`)).toBe(false);
  });

  it.each(["unknown", ""])("does not borrow a license from the source cell (%s)", (license) => {
    expect(hasKnownLicense(`| ambient-fixture.wav | Self-made, MIT reference | ${license} |`)).toBe(
      false,
    );
  });

  it("does not borrow a license from the file cell", () => {
    expect(hasKnownLicense("| MIT.wav | fixture source | unknown |")).toBe(false);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const audioFiles = () => walk(AUDIO_DIR).filter((f) => AUDIO_EXT.test(f));

describe("soundscape assets", () => {
  it("has ASSETS.md next to the code", () => {
    expect(statSync(ASSETS_MD).isFile()).toBe(true);
  });

  it("ships an ambient loop for every theme, named ambient-<themeId>", () => {
    const names = audioFiles().map((f) => basename(f, extname(f)));
    for (const theme of THEMES) expect(names).toContain(`ambient-${theme}`);
  });

  it("keeps every audio file under 500 KB", () => {
    const files = audioFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(statSync(file).size, relative(AUDIO_DIR, file)).toBeLessThan(MAX_BYTES);
    }
  });

  it("lists every audio file in ASSETS.md with a source and a license", () => {
    const rows = readFileSync(ASSETS_MD, "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("|"));
    const files = audioFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const name = basename(file);
      const row = rows.find((line) => assetCells(line)[0] === name);
      expect(row, `${name} has no row in ASSETS.md`).toBeDefined();
      const cells = assetCells(row ?? "");
      expect(cells.length, `${name} row needs file, source and license`).toBeGreaterThanOrEqual(3);
      expect(cells[1], `${name} needs a source`).not.toBe("");
      expect(hasKnownLicense(row ?? ""), `${name} needs a recognised license`).toBe(true);
    }
  });

  it("does not list files that are not there", () => {
    const present = new Set(audioFiles().map((f) => basename(f)));
    const mentioned =
      readFileSync(ASSETS_MD, "utf8").match(new RegExp(`[\\w.-]+\\.(?:${EXTENSIONS})`, "gi")) ?? [];
    for (const name of mentioned)
      expect(present.has(name), `${name} is listed but missing`).toBe(true);
  });
});
