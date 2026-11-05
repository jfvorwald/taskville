import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCwd } from "../src/main.ts";

// M7.10 (#382) real-use fix: `pnpm taskville ...` runs the CLI with the process cwd moved to the
// repository, and sets INIT_CWD to the folder the user ran pnpm from.
// Seam: main.ts exports `resolveCwd(env, processCwd): string`, a pure function of the
// environment (a record of strings) and the process cwd. It returns env.INIT_CWD when that is an
// absolute path to an existing directory, otherwise processCwd. main.ts uses it for io.cwd.

const root = mkdtempSync(join(tmpdir(), "taskville-cwd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const REPO = "/some/repo";

describe("resolveCwd", () => {
  it("uses INIT_CWD when it is an existing absolute directory", () => {
    const dir = join(root, "user-folder");
    mkdirSync(dir);
    expect(resolveCwd({ INIT_CWD: dir }, REPO)).toBe(dir);
  });

  it("falls back to the process cwd when INIT_CWD is unset or empty", () => {
    expect(resolveCwd({}, REPO)).toBe(REPO);
    expect(resolveCwd({ INIT_CWD: "" }, REPO)).toBe(REPO);
  });

  it("falls back when INIT_CWD is relative", () => {
    mkdirSync(join(root, "rel"), { recursive: true });
    expect(resolveCwd({ INIT_CWD: "rel" }, REPO)).toBe(REPO);
    expect(resolveCwd({ INIT_CWD: "." }, REPO)).toBe(REPO);
  });

  it("falls back when INIT_CWD does not exist or is a file", () => {
    expect(resolveCwd({ INIT_CWD: join(root, "missing") }, REPO)).toBe(REPO);
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    expect(resolveCwd({ INIT_CWD: file }, REPO)).toBe(REPO);
  });
});
