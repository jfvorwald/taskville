import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderStatus, retiredNotes, statusJson } from "../src/status.ts";
import { cli, tempDir } from "./helpers.ts";

// M2.19 (decision #202 D2): `status --all` and `requests --all` say how many older records
// retention (M2.16) dropped from the projection but kept in the event log.

const ZERO = { agents: 0, tasks: 0, requests: 0 };

function snapshot(retired: Record<string, number> | undefined) {
  const state = {
    agents: {},
    tasks: {},
    requests: {},
    activity: {},
    teams: {},
    head: 7,
    ...(retired === undefined ? {} : { retired }),
  };
  return {
    projectId: "p1",
    cursor: 7,
    stateHash: "h",
    reducerVersion: 5,
    computedAt: "2026-10-31T10:00:00Z",
    state,
    attention: [],
  };
}

describe("retiredNotes", () => {
  it("is empty when every count is zero", () => {
    expect(retiredNotes(ZERO, ["agents", "tasks", "requests"])).toEqual([]);
  });

  it("pins the wording per kind, with the count first", () => {
    expect(retiredNotes({ agents: 12, tasks: 3, requests: 40 }, ["agents", "tasks", "requests"])).toEqual([
      "12 older finished agents are in the event log",
      "3 older finished tasks are in the event log",
      "40 older closed requests are in the event log",
    ]);
  });

  it("uses the singular for one", () => {
    expect(retiredNotes({ agents: 1, tasks: 1, requests: 1 }, ["agents", "tasks", "requests"])).toEqual([
      "1 older finished agent is in the event log",
      "1 older finished task is in the event log",
      "1 older closed request is in the event log",
    ]);
  });

  it("lists only the kinds asked for and skips zeros", () => {
    expect(retiredNotes({ agents: 0, tasks: 5, requests: 9 }, ["agents", "tasks"])).toEqual([
      "5 older finished tasks are in the event log",
    ]);
  });
});

describe("status --all", () => {
  const withCounts = snapshot({ agents: 12, tasks: 3, requests: 40 });

  it("prints one line per non-zero agent and task count", () => {
    const out = renderStatus(withCounts as never, { projectName: "Demo", all: true });
    expect(out).toContain("12 older finished agents are in the event log\n");
    expect(out).toContain("3 older finished tasks are in the event log\n");
    expect(out).not.toContain("closed requests");
  });

  it("prints nothing extra when the counts are zero or absent", () => {
    for (const s of [snapshot(ZERO), snapshot(undefined)]) {
      const out = renderStatus(s as never, { projectName: "Demo", all: true });
      expect(out).not.toContain("event log");
    }
  });

  it("prints nothing extra without --all", () => {
    const out = renderStatus(withCounts as never, { projectName: "Demo", all: false });
    expect(out).not.toContain("event log");
  });

  it("carries the counts in JSON with --all only", () => {
    expect(statusJson(withCounts as never, { all: true }).retired).toEqual({
      agents: 12,
      tasks: 3,
      requests: 40,
    });
    expect(statusJson(withCounts as never, { all: false })).not.toHaveProperty("retired");
    expect(statusJson(snapshot(undefined) as never, { all: true }).retired).toEqual(ZERO);
  });
});

describe("requests --all", () => {
  const home = tempDir();
  let server: Server;
  let url = "";
  const retiredByProject: Record<string, Record<string, number>> = {
    a: { agents: 2, tasks: 0, requests: 30 },
    b: { agents: 0, tasks: 0, requests: 25 },
    c: ZERO,
  };

  beforeAll(async () => {
    mkdirSync(home.path, { recursive: true });
    writeFileSync(join(home.path, "token"), "tok\n", { mode: 0o600 });
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      const match = /^\/v1\/projects\/([^/]+)\/snapshot$/.exec(req.url ?? "");
      if (req.url === "/v1/projects") {
        res.end(JSON.stringify({ projects: Object.keys(retiredByProject).map((id) => ({ id, name: id })) }));
      } else if (match?.[1] !== undefined && retiredByProject[match[1]] !== undefined) {
        res.end(JSON.stringify({ ...snapshot(retiredByProject[match[1]]), projectId: match[1] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "no" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    home.remove();
  });

  const run = (...args: string[]) => cli(["requests", "--home", home.path, "--url", url, ...args]);

  it("sums the closed-request count across projects, before the answer hint", async () => {
    const result = await run("--all");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "No requests.\n55 older closed requests are in the event log\nAnswer from the paired browser or in the agent's terminal.\n",
    );
  });

  it("shows only the requested project's count", async () => {
    const result = await run("--all", "--project", "b");
    expect(result.stdout).toContain("25 older closed requests are in the event log\n");
  });

  it("prints no line when the count is zero", async () => {
    const result = await run("--all", "--project", "c");
    expect(result.stdout).not.toContain("event log");
  });

  it("prints no line without --all", async () => {
    const result = await run("--project", "a");
    expect(result.stdout).not.toContain("event log");
  });

  it("carries the counts in JSON with --all only", async () => {
    const all = JSON.parse((await run("--all", "--json")).stdout);
    expect(all.retired).toEqual({ agents: 2, tasks: 0, requests: 55 });
    const open = JSON.parse((await run("--json")).stdout);
    expect(open).not.toHaveProperty("retired");
  });
});
