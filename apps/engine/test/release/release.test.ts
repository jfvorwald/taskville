import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRelease } from "../../src/release/index.ts";
import { bearer, CLI_TOKEN, makeApp } from "../http/helpers.ts";

// M7.26 (#421). The engine reads an optional release.json (`{ id, version, commit, environment }`)
// from a directory next to its entry point and reports `{ id, version, environment }` on /health.
// The directory is injectable (`dir`) so tests never write next to real source.

let dir: string;
let home: string;
let savedHome: string | undefined;
let savedTvHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tv-release-"));
  home = mkdtempSync(join(tmpdir(), "tv-release-home-"));
  savedHome = process.env.HOME;
  savedTvHome = process.env.TASKVILLE_HOME;
  process.env.HOME = home;
  process.env.TASKVILLE_HOME = join(home, ".taskville");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedTvHome === undefined) delete process.env.TASKVILLE_HOME;
  else process.env.TASKVILLE_HOME = savedTvHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function capture() {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });
  return { logger, lines };
}

async function healthRelease(release: ReturnType<typeof loadRelease>) {
  const { app } = makeApp({ release });
  const res = await app.request("/health", { headers: bearer(CLI_TOKEN) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("loadRelease", () => {
  it("falls back to the dev identity when there is no release.json", () => {
    const { logger } = capture();
    const release = loadRelease({ dir, version: "0.0.0", logger });
    expect(release).toMatchObject({ id: "dev", environment: "development" });
  });

  it("falls back to dev when the directory does not exist", () => {
    const { logger } = capture();
    const release = loadRelease({ dir: join(dir, "missing"), version: "0.0.0", logger });
    expect(release).toMatchObject({ id: "dev", environment: "development" });
  });

  it("reads id, version and environment from release.json", () => {
    writeFileSync(
      join(dir, "release.json"),
      JSON.stringify({
        id: "20261106-abc1234",
        version: "1.4.0",
        commit: "abc1234def5678abc1234def5678abc1234def56",
        environment: "staging",
      }),
    );
    const { logger } = capture();
    expect(loadRelease({ dir, version: "0.0.0", logger })).toEqual({
      id: "20261106-abc1234",
      version: "1.4.0",
      environment: "staging",
    });
  });

  it("does not crash on malformed JSON: reports dev and logs it", () => {
    writeFileSync(join(dir, "release.json"), "{ not json");
    const { logger, lines } = capture();
    const release = loadRelease({ dir, version: "0.0.0", logger });
    expect(release).toMatchObject({ id: "dev", environment: "development" });
    const warned = lines.map((l) => JSON.parse(l) as { level: number; msg: string });
    expect(warned.some((l) => l.level >= 40 && /release/i.test(l.msg))).toBe(true);
  });

  it("falls back to dev when release.json has the wrong shape", () => {
    for (const body of [
      "[]",
      "null",
      '"x"',
      "{}",
      '{"id":7,"environment":"staging"}',
      '{"id":"r1","environment":"moon"}',
      '{"id":"","environment":"staging"}',
    ]) {
      writeFileSync(join(dir, "release.json"), body);
      const { logger } = capture();
      expect(loadRelease({ dir, version: "0.0.0", logger }), body).toMatchObject({
        id: "dev",
        environment: "development",
      });
    }
  });

  it("falls back to dev when release.json is a directory", () => {
    mkdirSync(join(dir, "release.json"));
    const { logger } = capture();
    expect(loadRelease({ dir, version: "0.0.0", logger })).toMatchObject({ id: "dev" });
  });
});

describe("GET /health release", () => {
  it("reports the dev identity by default, without any release option", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", { headers: bearer(CLI_TOKEN) });
    const body = (await res.json()) as { release?: unknown };
    expect(body.release).toMatchObject({ id: "dev", environment: "development" });
  });

  it("reports a release.json that was read", async () => {
    writeFileSync(
      join(dir, "release.json"),
      JSON.stringify({
        id: "r-42",
        version: "2.0.1",
        commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        environment: "production",
      }),
    );
    const { logger } = capture();
    const body = await healthRelease(loadRelease({ dir, version: "0.0.0", logger }));
    expect(body.release).toEqual({ id: "r-42", version: "2.0.1", environment: "production" });
  });

  it("never leaks the commit or any path", async () => {
    writeFileSync(
      join(dir, "release.json"),
      JSON.stringify({
        id: "r-43",
        version: "2.0.2",
        commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        environment: "staging",
        builtAt: "/Users/someone/build",
      }),
    );
    const { logger } = capture();
    const body = await healthRelease(loadRelease({ dir, version: "0.0.0", logger }));
    const text = JSON.stringify(body.release);
    expect(Object.keys(body.release as object).sort()).toEqual(["environment", "id", "version"]);
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain(dir);
    expect(text).not.toContain("/Users/");
  });

  it("keeps the existing health fields", async () => {
    const { logger } = capture();
    const body = await healthRelease(loadRelease({ dir, version: "0.0.0", logger }));
    expect(body).toMatchObject({ status: "ok", uptimeSeconds: expect.any(Number) });
  });
});
