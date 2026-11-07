// Contract coverage (S-3, option C): the in-Worker `/v1` is a second implementation of the read
// API, so a scan of the web client keeps the list of routes it must answer honest.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeStaging, pair, withSession } from "./support.ts";

const WEB_SRC = join(import.meta.dirname, "../../../apps/web/src");

type Kind = "json" | "sse";
interface Route {
  readonly method: "GET" | "POST";
  /** Normalized the way the scan normalizes: every id is `:id`. */
  readonly pattern: string;
  readonly kind: Kind;
  /** Route is public (pairing); the session cases do not apply. */
  readonly public?: boolean;
}

/** The routes the client calls today (S-3, "The web client reads ..."). */
const ROUTES: readonly Route[] = [
  { method: "GET", pattern: "/health", kind: "json" },
  { method: "POST", pattern: "/v1/pairing", kind: "json", public: true },
  { method: "GET", pattern: "/v1/projects", kind: "json" },
  { method: "GET", pattern: "/v1/projects/:id/timelines", kind: "json" },
  { method: "GET", pattern: "/v1/projects/:id/snapshot", kind: "json" },
  { method: "GET", pattern: "/v1/projects/:id/events", kind: "sse" },
  { method: "GET", pattern: "/v1/attention/events", kind: "sse" },
  { method: "GET", pattern: "/v1/agents/:id/feed", kind: "sse" },
  { method: "GET", pattern: "/v1/agents/:id/cost", kind: "json" },
  { method: "GET", pattern: "/v1/timelines/:id/events", kind: "json" },
  { method: "GET", pattern: "/v1/timelines/:id/state", kind: "json" },
  { method: "GET", pattern: "/v1/evidence/:id", kind: "json" },
  { method: "GET", pattern: "/v1/requests/:id/input", kind: "json" },
  { method: "POST", pattern: "/v1/commands", kind: "json" },
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...(await sourceFiles(path)));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function normalize(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, ":id")
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":id" : segment))
    .join("/")
    .replace(/[.-]+$/, "");
}

/** Every `/v1/...` and `/health` path the client's non-test sources mention, ids normalized. */
async function scanClientPaths(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const file of await sourceFiles(WEB_SRC)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/(?<![\w/.:$-])\/v1(?:\/(?:\$\{[^}]*\}|[\w:.-]+))*/g)) {
      const path = normalize(match[0]);
      if (path !== "/v1") found.add(path);
    }
    for (const match of text.matchAll(/(?<![\w/.:$-])\/health\b(?!-)/g)) found.add(match[0]);
  }
  return found;
}

/** A path is known if a route equals it, or it is the shared base of longer routes. */
function isKnown(path: string): boolean {
  return ROUTES.some((route) => route.pattern === path || route.pattern.startsWith(`${path}/`));
}

describe("web client contract", () => {
  it("scans the client and finds only routes this suite knows how to drive", async () => {
    const scanned = await scanClientPaths();
    expect(scanned.size).toBeGreaterThan(5);
    expect(scanned).toContain("/health");
    expect(scanned).toContain("/v1/projects");
    const unknown = [...scanned].filter((path) => !isKnown(path));
    expect(
      unknown,
      "client calls routes missing from ROUTES: add them here and to the Worker",
    ).toEqual([]);
  });

  it("covers every leaf route the client calls", async () => {
    const scanned = await scanClientPaths();
    for (const route of ROUTES) {
      const mentioned = [...scanned].some(
        (path) => path === route.pattern || route.pattern.startsWith(`${path}/`),
      );
      expect(mentioned, `client no longer mentions ${route.pattern}`).toBe(true);
    }
  });

  describe("the Worker answers each route for a paired session with JSON or SSE, never a 404", () => {
    for (const route of ROUTES.filter((r) => r.public !== true)) {
      it(`${route.method} ${route.pattern}`, async () => {
        const staging = makeStaging();
        const session = await pair(staging);
        const projects = (await (
          await staging.call("/v1/projects", withSession(session))
        ).json()) as { projects: { id: string }[] };
        const projectId = projects.projects[0]?.id ?? "demo";

        let id = 0;
        const path = route.pattern.replace(/:id/g, () =>
          id++ === 0 && route.pattern.startsWith("/v1/projects/") ? projectId : "unknown-id",
        );
        const query = route.pattern.endsWith("/state")
          ? "?at=1"
          : route.kind === "sse"
            ? "?after=0"
            : route.pattern.endsWith("/input")
              ? "?projectId=demo"
              : "";
        const init: RequestInit =
          route.method === "POST"
            ? {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Origin: "https://taskville-staging.jaqstudios.com",
                },
                body: JSON.stringify({
                  type: "permission.decide",
                  projectId,
                  requestId: "r1",
                  idempotencyKey: "k1",
                  context: { mode: "live" },
                  decision: { behavior: "allow" },
                }),
              }
            : {};

        const response = await staging.call(`${path}${query}`, withSession(session, init));

        if (route.pattern.endsWith("/cost")) {
          // Exactly like the engine: no telemetry is a 404 the client reads as "no cost". A 2xx
          // zero would show a false figure.
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({
            error: { code: "no_cost", message: expect.any(String) },
          });
          return;
        }
        expect(response.status).not.toBe(404);
        // The one non-2xx the client handles as a normal answer: a request that is no longer
        // held (nothing is, here), for a held-request read and for a decision on one.
        const expired =
          (route.pattern.endsWith("/input") || route.pattern.endsWith("/commands")) &&
          response.status === 410;
        const ok = response.ok || expired;
        expect(ok, `status ${response.status}`).toBe(true);
        const type = response.headers.get("content-type") ?? "";
        if (route.kind === "sse") {
          expect(type).toContain("text/event-stream");
          await response.body?.cancel();
        } else {
          expect(type).toContain("application/json");
          await response.json();
        }
      });
    }
  });
});
