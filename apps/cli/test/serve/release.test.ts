import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeServe, RELEASE_DIR } from "../../src/commands/serve.ts";
import { freePort, tempDir } from "../helpers.ts";

// M7.26 (#421): the engine reads release.json from the directory of the CLI package, the
// entry point's home, and reports `release` on /health. A checkout has none: dev identity.

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("serve release identity", () => {
  it("RELEASE_DIR is the apps/cli directory in a checkout", () => {
    expect(resolve(RELEASE_DIR)).toBe(CLI_DIR);
  });

  it("reports the dev identity on /health when no release.json is present", async () => {
    const home = tempDir();
    try {
      const port = await freePort();
      const parts = composeServe(
        { stdout: () => {}, stderr: () => {}, env: {}, cwd: home.path },
        home.path,
        port,
      );
      try {
        const token = readFileSync(join(home.path, "token"), "utf8").trim();
        const res = await parts.app.request("/health", {
          headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { release?: unknown };
        expect(body.release).toMatchObject({ id: "dev", environment: "development" });
        expect(Object.keys(body.release as object).sort()).toEqual([
          "environment",
          "id",
          "version",
        ]);
      } finally {
        await parts.close();
      }
    } finally {
      home.remove();
    }
  });

  it("reports the release.json found in an injected release directory", async () => {
    const home = tempDir();
    const releaseDir = tempDir("taskville-release-");
    try {
      writeFileSync(
        join(releaseDir.path, "release.json"),
        JSON.stringify({
          id: "20261106-abc1234",
          version: "1.4.0",
          commit: "abc1234def5678abc1234def5678abc1234def56",
          environment: "staging",
        }),
      );
      const port = await freePort();
      const parts = composeServe(
        { stdout: () => {}, stderr: () => {}, env: {}, cwd: home.path },
        home.path,
        port,
        { file: false, stderr: false },
        { releaseDir: releaseDir.path },
      );
      try {
        const token = readFileSync(join(home.path, "token"), "utf8").trim();
        const res = await parts.app.request("/health", {
          headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { release?: unknown };
        expect(body.release).toEqual({
          id: "20261106-abc1234",
          version: "1.4.0",
          environment: "staging",
        });
      } finally {
        await parts.close();
      }
    } finally {
      home.remove();
      releaseDir.remove();
    }
  });
});
