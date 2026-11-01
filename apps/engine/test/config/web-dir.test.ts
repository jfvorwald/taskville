import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WEB_DIR, resolveWebDir } from "../../src/config/web-dir.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskville-webdir-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWebDir", () => {
  it("defaults to apps/web/dist in the repository", () => {
    expect(DEFAULT_WEB_DIR.endsWith(join("apps", "web", "dist"))).toBe(true);
  });

  it("uses TASKVILLE_WEB_DIR when it holds an index.html", () => {
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    expect(resolveWebDir({ TASKVILLE_WEB_DIR: dir })).toEqual({ dir });
  });

  it("reports a missing build instead of serving an empty directory", () => {
    const result = resolveWebDir({ TASKVILLE_WEB_DIR: join(dir, "nope") });
    expect(result).toEqual({ dir: undefined, missing: join(dir, "nope") });
    mkdirSync(join(dir, "empty"));
    expect(resolveWebDir({ TASKVILLE_WEB_DIR: join(dir, "empty") }).dir).toBeUndefined();
  });
});
