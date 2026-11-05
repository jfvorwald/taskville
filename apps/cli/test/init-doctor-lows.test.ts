import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cli, tempDir } from "./helpers.ts";

// M7.16 (#393), M7.10 lows L2 and L3 (L1 is deliberate and closed). Red phase.
//   L2: doctor never prints control characters that came from a project name (an ESC sequence
//       could rewrite the terminal). Each is replaced by a visible placeholder; ordinary text and
//       the newline that ends a line stay. init needs no test: the engine already answers 400
//       for a control character in a project name or root, and init prints only that sentence.
//   L3: doctor's curl check ignores an empty PATH entry (it would resolve to the current folder).

const dirs: { remove: () => void }[] = [];
afterAll(() => {
  for (const d of dirs) d.remove();
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the test
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const EVIL = "evil\u001b[31mred\u0007";

describe("taskville doctor", () => {
  it("prints no control character from a project name (L2)", async () => {
    const dir = tempDir("taskville-lows-doctor-");
    dirs.push(dir);
    const root = realpathSync(dir.path);
    const tv = join(root, "tv");
    mkdirSync(tv);
    const r = await cli(["doctor", "--home", tv], {
      env: { HOME: root },
      cwd: root,
      doctor: {
        nodeVersion: "26.8.2",
        webClientBuilt: () => true,
        engineHealthy: async () => true,
        onPath: () => true,
        listProjects: async () => [{ id: "p1", name: EVIL, roots: [root] }],
      },
    } as Parameters<typeof cli>[1]);
    expect(r.stdout).toMatch(/project/);
    expect(r.stdout).not.toMatch(CONTROL);
  });

  it("does not take an empty PATH entry for the current folder (L3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskville-lows-path-"));
    dirs.push({ remove: () => rmSync(dir, { recursive: true, force: true }) });
    const here = realpathSync(dir);
    writeFileSync(join(here, "curl"), "#!/bin/sh\n");
    chmodSync(join(here, "curl"), 0o755);
    const tv = join(here, "tv");
    mkdirSync(tv);
    const before = process.cwd();
    process.chdir(here);
    try {
      const r = await cli(["doctor", "--home", tv], {
        env: { HOME: here, PATH: ":/nonexistent-bin-dir" },
        cwd: here,
        doctor: {
          nodeVersion: "26.8.2",
          webClientBuilt: () => true,
          engineHealthy: async () => true,
          listProjects: async () => [],
        },
      } as Parameters<typeof cli>[1]);
      expect(r.stdout).toMatch(/^fail curl:/m);
    } finally {
      process.chdir(before);
    }
  });
});
