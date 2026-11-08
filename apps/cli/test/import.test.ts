// M8.08: `taskville import git|transcripts` against a fake engine (an in-test HTTP server).
// Contract: docs/superpowers/specs/2026-11-08-imports-design.md (CLI, Imports API).
// Encoded seams: `apps/cli/src/commands/import.ts` exports `importCommand(io, args)` and main.ts
// registers it as `import`; `Io.importPollMs` (context.ts) is the injectable poll interval.

import { getEventListeners } from "node:events";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cli, freePort, tempDir } from "./helpers.ts";

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

interface Project {
  id: string;
  name: string;
  roots: string[];
  head: number;
}

const counts = (over: Record<string, unknown> = {}) => ({
  read: 0,
  imported: 0,
  skipped: 0,
  malformed: 0,
  ...over,
});

const record = (status: string, over: Record<string, unknown> = {}) => ({
  importId: "imp-1",
  archiveId: "imp-1",
  projectId: "alpha",
  kind: "git",
  status,
  counts: counts(),
  startedAt: "2026-11-08T10:00:00.000Z",
  ...over,
});

const home = tempDir();
const work = tempDir();
// macOS temp dirs sit behind a symlink; the CLI compares real paths.
const base = realpathSync(work.path);
const rootAlpha = join(base, "alpha");
const rootNested = join(base, "alpha", "nested");
const rootBeta = join(base, "beta");
const outside = join(base, "elsewhere");
for (const dir of [rootAlpha, join(rootNested, "src"), join(rootAlpha, "src"), rootBeta, outside]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(home.path, "token"), "cli-token\n");

let server: Server;
let url = "";
let seen: Seen[] = [];
let projects: Project[] = [];
let startReply: { status: number; body: unknown } = {
  status: 202,
  body: { importId: "imp-1", archiveId: "imp-1", status: "running" },
};
/** GET /v1/imports/:id answers these in order; the last one repeats. */
let statuses: unknown[] = [];
let polled = 0;
/** Milliseconds the fake engine waits before answering POST /v1/imports. */
let startDelayMs = 0;
/** When set, GET /v1/imports/imp-1 follows this script instead of `statuses` ("drop" kills the socket). */
let pollScript: ({ status: number; body: unknown } | "drop")[] | undefined;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => resolve(text === "" ? undefined : JSON.parse(text)));
  });
}

beforeAll(async () => {
  const port = await freePort();
  server = createServer(async (req, res) => {
    const path = req.url ?? "";
    const body = await readBody(req);
    seen.push({ method: req.method ?? "", path, auth: req.headers.authorization, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && path === "/v1/projects") return send(200, { projects });
    if (req.method === "POST" && path === "/v1/imports")
      return void setTimeout(() => send(startReply.status, startReply.body), startDelayMs);
    if (req.method === "GET" && path === "/v1/imports/imp-1") {
      if (pollScript !== undefined) {
        const step = pollScript[Math.min(polled, pollScript.length - 1)];
        polled += 1;
        if (step === "drop" || step === undefined) return req.socket.destroy();
        return send(step.status, step.body);
      }
      const next = statuses[Math.min(polled, statuses.length - 1)];
      polled += 1;
      return send(200, next);
    }
    return send(404, { error: { code: "not_found", message: "no" } });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  home.remove();
  work.remove();
});

afterEach(() => {
  seen = [];
  polled = 0;
  startReply = {
    status: 202,
    body: { importId: "imp-1", archiveId: "imp-1", status: "running" },
  };
  statuses = [];
  projects = [];
  pollScript = undefined;
  startDelayMs = 0;
});

function setup(): void {
  projects = [
    { id: "alpha", name: "Alpha", roots: [rootAlpha, rootNested], head: 0 },
    { id: "beta", name: "Beta", roots: [rootBeta], head: 0 },
  ];
  statuses = [
    record("running", { counts: counts({ read: 120, imported: 118 }) }),
    record("done", { counts: counts({ read: 345, imported: 340, skipped: 3, malformed: 2 }) }),
  ];
}

/** Globals lead (M7.18); the fast poll interval is injected. */
const imp = (args: string[], cwd: string, extra: string[] = []) =>
  cli(["--home", home.path, "--url", url, ...extra, "import", ...args], {
    cwd,
    importPollMs: 5,
  });

const posts = () => seen.filter((s) => s.method === "POST");

describe("taskville import: request and defaults", () => {
  it("posts projectId, kind and root with the CLI token, defaulting from the current directory", async () => {
    setup();
    const result = await imp(["git"], join(rootAlpha, "src"));
    expect(result.code).toBe(0);
    expect(posts()).toHaveLength(1);
    const post = posts()[0] as Seen;
    expect(post.path).toBe("/v1/imports");
    expect(post.auth).toBe("Bearer cli-token");
    expect(post.body).toEqual({ projectId: "alpha", kind: "git", root: rootAlpha });
  });

  it("picks the deepest configured root that contains the current directory", async () => {
    setup();
    const result = await imp(["transcripts"], join(rootNested, "src"));
    expect(result.code).toBe(0);
    expect((posts()[0] as Seen).body).toEqual({
      projectId: "alpha",
      kind: "transcripts",
      root: rootNested,
    });
  });

  it("lets --project and --root override the defaults", async () => {
    setup();
    const result = await imp(
      ["git", "--project", "beta", "--root", rootBeta],
      join(rootAlpha, "src"),
    );
    expect(result.code).toBe(0);
    expect((posts()[0] as Seen).body).toEqual({ projectId: "beta", kind: "git", root: rootBeta });
  });

  it("exits 1 with a clear message when no project root contains the current directory", async () => {
    setup();
    const result = await imp(["git"], outside);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no project/i);
    expect(result.stderr).toContain("--project");
    expect(posts()).toHaveLength(0);
  });

  it("accepts the global options before the command", async () => {
    setup();
    const result = await cli(["--json", "--home", home.path, "--url", url, "import", "git"], {
      cwd: rootAlpha,
      importPollMs: 5,
    });
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

describe("taskville import: polling and output", () => {
  it("polls until done, printing progress counts and a final summary", async () => {
    setup();
    const result = await imp(["git"], rootAlpha);
    expect(result.code).toBe(0);
    const gets = seen.filter((s) => s.path === "/v1/imports/imp-1");
    expect(gets.length).toBeGreaterThanOrEqual(2);
    expect(gets.every((g) => g.auth === "Bearer cli-token")).toBe(true);
    // Progress from the running poll, then the final counts.
    expect(result.stdout).toContain("120");
    expect(result.stdout).toContain("118");
    for (const n of ["345", "340"]) expect(result.stdout).toContain(n);
    expect(result.stdout).toMatch(/done/i);
    expect(result.stdout).toMatch(/skipped\D*3|3\D*skipped/i);
    expect(result.stdout).toMatch(/malformed\D*2|2\D*malformed/i);
  });

  it("--json prints only the final status record", async () => {
    setup();
    const result = await imp(["git"], rootAlpha, ["--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(statuses[1]);
  });

  it("says when the import was truncated", async () => {
    setup();
    statuses = [
      record("done", { counts: counts({ read: 50000, imported: 50000, truncated: true }) }),
    ];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/truncated/i);
  });

  it("exits 1 and shows the error when the import failed", async () => {
    setup();
    statuses = [
      record("running"),
      record("failed", { error: { code: "git_failed", message: "git exploded" } }),
    ];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("git exploded");
  });

  it("exits 1 when the import was cancelled", async () => {
    setup();
    statuses = [record("running"), record("cancelled")];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/cancelled/i);
  });

  it("--json still exits 1 on failure and prints the failed record", async () => {
    setup();
    const failed = record("failed", { error: { code: "git_failed", message: "git exploded" } });
    statuses = [failed];
    const result = await imp(["git"], rootAlpha, ["--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(failed);
  });
});

describe("taskville import: engine errors", () => {
  const fail = (status: number, code: string) => {
    startReply = { status, body: { error: { code, message: "engine words" } } };
  };

  it("root_not_configured names the configured roots or how to add one", async () => {
    setup();
    fail(400, "root_not_configured");
    const result = await imp(["git"], rootAlpha);
    expect(result.code).not.toBe(0);
    expect(posts()).toHaveLength(1);
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.stderr).toMatch(new RegExp(`${rootAlpha}|project add|--root`));
  });

  it("import_running says an import is already running", async () => {
    setup();
    fail(409, "import_running");
    const result = await imp(["git"], rootAlpha);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/already running/i);
  });

  it("unknown_import_kind says the engine has no importer for it", async () => {
    setup();
    fail(400, "unknown_import_kind");
    const result = await imp(["transcripts"], rootAlpha);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/no importer|not available|not supported/i);
  });

  it("engine_closing says the engine is shutting down", async () => {
    setup();
    fail(503, "engine_closing");
    const result = await imp(["git"], rootAlpha);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/shutting down/i);
  });

  it("engine not running gives the existing hint and exit 3", async () => {
    const dead = await freePort();
    const result = await cli(
      [
        "--home",
        home.path,
        "--url",
        `http://127.0.0.1:${dead}`,
        "import",
        "git",
        "--project",
        "alpha",
        "--root",
        rootAlpha,
      ],
      { cwd: rootAlpha, importPollMs: 5 },
    );
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("taskville start");
  });
});

describe("taskville import: usage", () => {
  it("rejects an unknown kind before contacting the engine", async () => {
    setup();
    const result = await imp(["svn"], rootAlpha);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.stderr).toContain("Usage");
    expect(result.stderr).toMatch(/git/);
    expect(result.stderr).toMatch(/transcripts/);
    expect(seen).toHaveLength(0);
  });

  it("rejects a missing kind before contacting the engine", async () => {
    setup();
    const result = await imp([], rootAlpha);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.stderr).toMatch(/import/);
    expect(result.stderr).toContain("Usage");
    expect(seen).toHaveLength(0);
  });

  it("lists the command in the help text", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/import (git\|transcripts|<kind>)/);
  });
});

const done = (over: Record<string, unknown> = {}) => ({ status: 200, body: record("done", over) });
const running = { status: 200, body: record("running") };

describe("taskville import: review fixes", () => {
  it("a child directory named ..work is inside the root, not outside it", async () => {
    setup();
    const child = join(rootAlpha, "..work");
    mkdirSync(child, { recursive: true });
    const result = await imp(["git"], child);
    expect(result.code).toBe(0);
    expect((posts()[0] as Seen).body).toEqual({ projectId: "alpha", kind: "git", root: rootAlpha });
  });

  it("does not accumulate abort listeners on io.signal while polling", async () => {
    setup();
    statuses = [
      ...Array.from({ length: 40 }, () => record("running")),
      record("done", { counts: counts({ read: 1 }) }),
    ];
    const controller = new AbortController();
    const result = await cli(["--home", home.path, "--url", url, "import", "git"], {
      cwd: rootAlpha,
      importPollMs: 1,
      signal: controller.signal,
    });
    expect(result.code).toBe(0);
    expect(polled).toBeGreaterThanOrEqual(40);
    expect(getEventListeners(controller.signal, "abort").length).toBeLessThanOrEqual(2);
  });

  it("Ctrl-C while polling exits without a stack trace and names the import", async () => {
    setup();
    statuses = [record("running")];
    const controller = new AbortController();
    const pending = cli(["--home", home.path, "--url", url, "import", "git"], {
      cwd: rootAlpha,
      importPollMs: 5,
      signal: controller.signal,
    });
    while (polled < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toMatch(/AbortError|\n\s+at /);
    expect(result.stderr).toContain("imp-1");
    expect(result.stderr).toMatch(/keeps running|still running|continues/i);
  });

  it("retries a dropped connection during polling", async () => {
    setup();
    pollScript = ["drop", "drop", done()];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/done/i);
  });

  it("retries a 5xx during polling", async () => {
    setup();
    const bad = { status: 503, body: { error: { code: "internal", message: "busy" } } };
    pollScript = [bad, bad, running, done()];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).toBe(0);
  });

  it("gives up after a few failures and says the import was started and the status unreadable", async () => {
    setup();
    pollScript = ["drop"];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).not.toBe(0);
    expect(polled).toBeGreaterThanOrEqual(3);
    expect(polled).toBeLessThan(30);
    expect(result.stderr).toContain("imp-1");
    expect(result.stderr).toMatch(/started/i);
    expect(result.stderr).toMatch(/could not read/i);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("a 404 on the import id prints a clear message", async () => {
    setup();
    pollScript = [{ status: 404, body: { error: { code: "not_found", message: "no" } } }];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("Engine error 404");
    expect(result.stderr).toContain("imp-1");
    expect(result.stderr).toMatch(/not found|unknown|no such/i);
  });

  it("asks for --project when two projects own the same real root", async () => {
    setup();
    const link = join(base, "alink");
    symlinkSync(rootAlpha, link);
    projects = [
      { id: "alpha", name: "Alpha", roots: [rootAlpha], head: 0 },
      { id: "twin", name: "Twin", roots: [link], head: 0 },
    ];
    const result = await imp(["git"], join(rootAlpha, "src"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--project");
    expect(result.stderr).toContain("alpha");
    expect(result.stderr).toContain("twin");
    expect(posts()).toHaveLength(0);
  });

  it("--project alone from outside its roots uses its only root", async () => {
    setup();
    const result = await imp(["git", "--project", "beta"], join(rootAlpha, "src"));
    expect(result.code).toBe(0);
    expect((posts()[0] as Seen).body).toEqual({ projectId: "beta", kind: "git", root: rootBeta });
  });

  it("--project alone from outside a multi-root project asks for --root", async () => {
    setup();
    const result = await imp(["git", "--project", "alpha"], outside);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--root");
    expect(result.stderr).not.toMatch(/No project root/);
    expect(posts()).toHaveLength(0);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "a refusal code %s prints a generic message",
    async (code) => {
      setup();
      startReply = { status: 400, body: { error: { code, message: "engine words" } } };
      const result = await imp(["git"], rootAlpha);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("engine words");
      expect(result.stderr).not.toMatch(/\[object|function|native code/);
    },
  );

  it("resolves a symlinked current directory through realpath", async () => {
    setup();
    const link = join(base, "cwdlink");
    symlinkSync(join(rootAlpha, "src"), link);
    const result = await imp(["git"], link);
    expect(result.code).toBe(0);
    expect((posts()[0] as Seen).body).toEqual({ projectId: "alpha", kind: "git", root: rootAlpha });
  });

  it("does not call an unknown terminal status cancelled", async () => {
    setup();
    statuses = [record("paused")];
    const result = await imp(["git"], rootAlpha);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("import ended with status paused");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/cancelled/i);
  });
});

describe("taskville import: Ctrl-C during the start request", () => {
  it("exits 1 without a stack trace and says the import may already be running", async () => {
    setup();
    startDelayMs = 300;
    const controller = new AbortController();
    const pending = cli(["--home", home.path, "--url", url, "import", "git"], {
      cwd: rootAlpha,
      importPollMs: 5,
      signal: controller.signal,
    });
    while (!seen.some((s) => s.method === "POST")) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const result = await pending;
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(/AbortError|\n\s+at /);
    expect(result.stderr).toMatch(/may already be running/i);
    expect(result.stderr).toMatch(/import_running|status/i);
  });
});
