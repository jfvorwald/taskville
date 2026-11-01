import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectState } from "@taskville/domain/reducer";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, HOST, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import {
  addProject,
  BASE,
  bootInProcess,
  type Engine,
  get,
  ingest,
  input,
  useDbPath,
} from "./helpers.ts";

// The timeline routes are read routes (contracts/http-api.md): the CLI token and a paired
// browser session may use them, the bridge token may not, Host and Origin are checked, there is
// no CORS and no cookie, and no path from history reaches the command service or writes anything.

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

const ROUTES = [
  "/v1/projects/demo/timelines",
  "/v1/timelines/live:demo/state?at=1",
  "/v1/timelines/live:demo/events?from=1&to=2",
];

function boot() {
  const booted = bootInProcess(dbPath());
  engine = booted.engine;
  addProject(engine.storage, "demo");
  return booted;
}

describe("credentials", () => {
  it("accepts the CLI token and a paired browser session on every timeline route", async () => {
    const booted = boot();
    const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";
    for (const path of ROUTES) {
      const cli = await get(booted.app, path, bearer(CLI_TOKEN));
      expect(cli.status, `cli ${path}`).toBe(200);
      const browser = await get(booted.app, path, sessionHeaders(session));
      expect(browser.status, `session ${path}`).toBe(200);
      const withOrigin = await get(booted.app, path, {
        ...sessionHeaders(session),
        Origin: ORIGIN,
      });
      expect(withOrigin.status, `session+origin ${path}`).toBe(200);
    }
  });

  it("refuses the bridge token with 403 credential_not_allowed", async () => {
    const booted = boot();
    for (const path of ROUTES) {
      const res = await get(booted.app, path, bearer(BRIDGE_TOKEN));
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "credential_not_allowed", message: expect.any(String) },
      });
    }
  });

  it("refuses no credential, a wrong token, and a cookie alone with 401", async () => {
    const booted = boot();
    for (const path of ROUTES) {
      expect((await get(booted.app, path)).status, `route exists: ${path}`).toBe(200);
      expect((await get(booted.app, path, { Host: HOST })).status, `none ${path}`).toBe(401);
      expect((await get(booted.app, path, bearer(`${CLI_TOKEN}x`))).status, `wrong ${path}`).toBe(
        401,
      );
      const cookie = await get(booted.app, path, { Host: HOST, Cookie: `session=${CLI_TOKEN}` });
      expect(cookie.status, `cookie ${path}`).toBe(401);
    }
  });

  it("checks Host and Origin before anything else", async () => {
    const booted = boot();
    for (const path of ROUTES) {
      expect((await get(booted.app, path)).status, `route exists: ${path}`).toBe(200);
      const host = await get(booted.app, path, {
        Authorization: `Bearer ${CLI_TOKEN}`,
        Host: "evil.example:4807",
      });
      expect(host.status, `host ${path}`).toBe(403);
      expect(((await host.json()) as { error: { code: string } }).error.code).toBe(
        "forbidden_host",
      );
      const origin = await get(booted.app, path, {
        ...bearer(CLI_TOKEN),
        Origin: "https://evil.example",
      });
      expect(origin.status, `origin ${path}`).toBe(403);
      expect(((await origin.json()) as { error: { code: string } }).error.code).toBe(
        "forbidden_origin",
      );
    }
  });

  it("never sends CORS headers or cookies", async () => {
    const booted = boot();
    for (const path of ROUTES) {
      const res = await get(booted.app, path, { ...bearer(CLI_TOKEN), Origin: ORIGIN });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("read-only", () => {
  it("reads leave the event log, heads and stored projections exactly as they were", async () => {
    const booted = boot();
    await ingest(booted.app, [input("e1"), input("e2"), input("e3")]);
    const storage = engine?.storage;
    if (!storage) throw new Error("no engine");
    const snapshot = () => ({
      projects: storage.projects(),
      events: ["demo", "unsorted"].map((p) => [...storage.events(p)]),
      projections: ["demo", "unsorted"].map((p) => storage.projection<ProjectState>(p)),
    });
    const before = snapshot();
    for (const path of [
      ...ROUTES,
      "/v1/timelines/live:demo/state?at=0",
      "/v1/timelines/live:demo/state?at=999999",
      "/v1/timelines/live:demo/state?at=2026-10-30T11:00:00Z",
      "/v1/timelines/live:demo/events?limit=1",
    ]) {
      const res = await get(booted.app, path, bearer(CLI_TOKEN));
      expect(res.status, path).toBe(200);
    }
    expect(snapshot()).toEqual(before);
  });

  it("offers no write method on any timeline route", async () => {
    const booted = boot();
    const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";
    const storage = engine?.storage;
    if (!storage) throw new Error("no engine");
    const eventsBefore = [...storage.events("demo")];
    const headersFor = [
      { ...bearer(CLI_TOKEN), "Content-Type": "application/json" },
      { ...sessionHeaders(session), Origin: ORIGIN, "Content-Type": "application/json" },
    ];
    for (const path of ROUTES) {
      expect((await get(booted.app, path)).status, `route exists: ${path}`).toBe(200);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const headers of headersFor) {
          const res = await booted.app.request(`${BASE}${path}`, {
            method,
            headers,
            body: JSON.stringify({ type: "command", at: 1 }),
          });
          expect([404, 405], `${method} ${path}`).toContain(res.status);
        }
      }
    }
    expect([...storage.events("demo")]).toEqual(eventsBefore);
  });
});

describe("history context never reaches the command service", () => {
  it("no source file under src/timelines imports the command service or appends events", () => {
    const dir = resolve(import.meta.dirname, "../../src/timelines");
    expect(existsSync(dir), "apps/engine/src/timelines does not exist yet").toBe(true);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*\/commands(\/|\.ts|["'])/);
      expect(text, file).not.toMatch(/\bappendEvent\b|\binsertProject\b|\bIngestPipeline\b/);
    }
  });
});
