import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs } from "../src/main.ts";
import { mermaidBlocks, validateMermaid } from "../src/mermaid.ts";
import { example, NOW } from "./example-snapshot.ts";

const main = join(import.meta.dirname, "..", "src", "main.ts");
const tmp = mkdtempSync(join(tmpdir(), "taskville-retro-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseArgs", () => {
  it("reads the milestone key and options", () => {
    expect(parseArgs(["M1"])).toEqual({ key: "M1" });
    expect(
      parseArgs([
        "M2",
        "--from",
        "s.json",
        "--record",
        "r.json",
        "--out",
        "o.md",
        "--now",
        "2026-01-01T00:00:00Z",
      ]),
    ).toEqual({
      key: "M2",
      from: "s.json",
      record: "r.json",
      out: "o.md",
      now: "2026-01-01T00:00:00Z",
    });
  });

  it.each([[[]], [["1"]], [["M1", "--bogus"]], [["M1", "--out"]], [["M1", "--now", "yesterday"]]])(
    "rejects %j",
    (argv) => {
      expect(() => parseArgs(argv)).toThrow(/Usage/);
    },
  );
});

describe("retro CLI, offline from a snapshot", () => {
  const from = join(tmp, "m9.json");
  const out = join(tmp, "M9.md");
  writeFileSync(from, JSON.stringify(example));
  const run = () =>
    execFileSync(
      process.execPath,
      [main, "M9", "--from", from, "--out", out, "--now", NOW.toISOString()],
      {
        encoding: "utf8",
      },
    );

  it("writes a report whose Mermaid validates", () => {
    expect(run()).toContain(out);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("# Retro: M9 Example");
    for (const block of mermaidBlocks(md)) expect(validateMermaid(block.source)).toEqual([]);
  });

  it("keeps written sections when run again", () => {
    const md = readFileSync(out, "utf8").replace(
      "## What hurt *(written)*\n",
      "## What hurt *(written)*\n\nRebases.\n",
    );
    writeFileSync(out, md);
    run();
    expect(readFileSync(out, "utf8")).toContain("## What hurt *(written)*\n\nRebases.\n");
  });

  it("refuses a snapshot from another milestone", () => {
    const result = spawnSync(
      process.execPath,
      [main, "M1", "--from", from, "--out", join(tmp, "x.md")],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/M9 Example/);
  });

  it("prints usage and exits 2 without a milestone key", () => {
    const result = spawnSync(process.execPath, [main], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage/);
  });
});
