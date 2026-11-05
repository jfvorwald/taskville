// M7.09: the CLI finds the running engine from <home>/engine.json (written by M7.08) and
// `taskville demo` works with no flags. Seam: `Io.isAlive?: (pid: number) => boolean` decides
// whether engine.json's pid is alive; tests inject it so nothing depends on real processes.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_URL } from "../src/client.ts";
import { discoverUrl, type Io } from "../src/context.ts";
import { cli, freePort, freePorts, tempDir } from "./helpers.ts";

const homes: { remove: () => void }[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.remove();
});

function homeWith(engine?: unknown | string): string {
  const dir = tempDir("taskville-discovery-");
  homes.push(dir);
  mkdirSync(dir.path, { recursive: true });
  writeFileSync(join(dir.path, "token"), "test-token\n", { mode: 0o600 });
  if (engine !== undefined) {
    const text = typeof engine === "string" ? engine : JSON.stringify(engine);
    writeFileSync(join(dir.path, "engine.json"), text, { mode: 0o600 });
  }
  return dir.path;
}

const record = (url: string, pid = 4242) => ({ url, pid, startedAt: "2026-11-04T10:00:00.000Z" });
const alive = (pid: number) => pid === 4242;
const dead = () => false;

/** Runs `project list` (any engine command works) and returns what it said. */
async function listAt(
  home: string,
  opts: {
    args?: string[];
    env?: Record<string, string>;
    isAlive?: (pid: number) => boolean;
  } = {},
) {
  return cli(["project", "list", "--home", home, ...(opts.args ?? [])], {
    cwd: home,
    env: opts.env ?? {},
    isAlive: opts.isAlive ?? alive,
  } as Parameters<typeof cli>[1]);
}

/** The pure resolver under test (exported from src/context.ts). */
function resolve(home: string, isAlive?: (pid: number) => boolean): string | undefined {
  const io: Io = {
    stdout: () => {},
    stderr: () => {},
    env: {},
    cwd: home,
    ...(isAlive === undefined ? {} : { isAlive }),
  };
  return discoverUrl(io, home);
}

describe("URL resolution (M7.09)", () => {
  it("uses --url before everything else", async () => {
    const [a, b, c] = await freePorts(3);
    const home = homeWith(record(`http://127.0.0.1:${c}`));
    const result = await listAt(home, {
      args: ["--url", `http://127.0.0.1:${a}`],
      env: { TASKVILLE_URL: `http://127.0.0.1:${b}` },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`127.0.0.1:${a}`);
  });

  it("uses $TASKVILLE_URL before engine.json", async () => {
    const [b, c] = await freePorts(2);
    const home = homeWith(record(`http://127.0.0.1:${c}`));
    const result = await listAt(home, { env: { TASKVILLE_URL: `http://127.0.0.1:${b}` } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`127.0.0.1:${b}`);
  });

  it.each(["127.0.0.1", "localhost"])("uses engine.json for %s with a live pid", async (host) => {
    const [port] = await freePorts(1);
    const seen: number[] = [];
    const home = homeWith(record(`http://${host}:${port}`));
    const result = await listAt(home, {
      isAlive: (pid) => {
        seen.push(pid);
        return alive(pid);
      },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`${host}:${port}`);
    expect(seen).toContain(4242);
  });

  it("resolves nothing with no engine.json, so the default applies", () => {
    expect(resolve(homeWith(), alive)).toBeUndefined();
    expect(DEFAULT_URL).toBe("http://127.0.0.1:4807");
  });

  it("falls back to the default URL on the wire when nothing listens there", async () => {
    // Only meaningful when 4807 is free; otherwise the answer depends on the machine.
    const probe = createTcpServer();
    const free = await new Promise<boolean>((done) => {
      probe.once("error", () => done(false));
      probe.listen(4807, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (!free) return;
    const result = await listAt(homeWith());
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("127.0.0.1:4807");
  });

  it("ignores engine.json when its pid is stale", async () => {
    const [port] = await freePorts(1);
    expect(resolve(homeWith(record(`http://127.0.0.1:${port}`)), dead)).toBeUndefined();
  });

  it("returns the url of a live loopback engine", async () => {
    const [port] = await freePorts(1);
    expect(resolve(homeWith(record(`http://127.0.0.1:${port}`)), alive)).toBe(
      `http://127.0.0.1:${port}`,
    );
  });

  it.each([
    "http://evil.example:4807",
    "http://127.0.0.1.evil.example:4807",
    "http://localhost.evil.example:4807",
    "https://127.0.0.1:4807",
    "http://user:pass@127.0.0.1:4807",
    "http://user@127.0.0.1:4807",
    "http://:pw@127.0.0.1:4807",
    "http://127.0.0.1@evil.example:4807",
    "http://evil.example:4807@127.0.0.1:4807",
    "http://0.0.0.0:4807",
    "http://127.0.0.1",
    "ftp://127.0.0.1:4807",
    "not a url",
    "",
  ])("ignores engine.json with the url %j", (url) => {
    expect(resolve(homeWith(record(url)), () => true)).toBeUndefined();
  });

  it.each([
    ["truncated JSON", '{"url": "http://127.0.0.1:5001", "pid": 42'],
    ["not JSON", "hello"],
    ["an array", "[]"],
    ["null", "null"],
    ["a missing pid", JSON.stringify({ url: "http://127.0.0.1:5001" })],
    ["a string pid", JSON.stringify({ url: "http://127.0.0.1:5001", pid: "4242" })],
    ["a missing url", JSON.stringify({ pid: 4242 })],
    ["a numeric url", JSON.stringify({ url: 5001, pid: 4242 })],
  ])("ignores engine.json that is %s", (_name, text) => {
    expect(resolve(homeWith(text), () => true)).toBeUndefined();
  });

  // The pid must be a positive int32: kill(0) and kill(-1) signal whole process groups.
  it.each([0, -1, 1.5, 2 ** 31, 2 ** 53])(
    "ignores engine.json with pid %s even if 'alive'",
    (pid) => {
      expect(resolve(homeWith(record("http://127.0.0.1:5001", pid)), () => true)).toBeUndefined();
    },
  );

  it("accepts the largest int32 pid", () => {
    expect(resolve(homeWith(record("http://127.0.0.1:5001", 2 ** 31 - 1)), () => true)).toBe(
      "http://127.0.0.1:5001",
    );
  });

  it.each([
    ["a path", "/x"],
    ["a query", "?a=b"],
    ["a fragment", "#f"],
    ["a path, query and fragment", "/x/y?a=b#f"],
  ])("uses the origin only when engine.json has %s", (_name, suffix) => {
    expect(resolve(homeWith(record(`http://127.0.0.1:4807${suffix}`)), alive)).toBe(
      "http://127.0.0.1:4807",
    );
  });

  it("does not send requests under an engine.json path", async () => {
    const [port] = await freePorts(1);
    const home = homeWith(record(`http://127.0.0.1:${port}/x`));
    const result = await listAt(home);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`127.0.0.1:${port}`);
    expect(result.stderr).not.toContain(`${port}/x`);
  });
});

describe("real liveness check (M7.09, no injected isAlive)", () => {
  it("treats this very process as alive", async () => {
    const [port] = await freePorts(1);
    const home = homeWith(record(`http://127.0.0.1:${port}`, process.pid));
    expect(resolve(home)).toBe(`http://127.0.0.1:${port}`);
  });

  it("treats a child that has exited as dead", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid as number;
    await new Promise((done) => child.once("close", done));
    const [port] = await freePorts(1);
    expect(resolve(homeWith(record(`http://127.0.0.1:${port}`, pid)))).toBeUndefined();
  });

  // pid 1 exists but belongs to root, so kill(1, 0) fails with EPERM: still alive.
  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "treats a live process owned by another user (EPERM) as alive",
    async () => {
      const [port] = await freePorts(1);
      expect(resolve(homeWith(record(`http://127.0.0.1:${port}`, 1)))).toBe(
        `http://127.0.0.1:${port}`,
      );
    },
  );
});

describe("hermetic helper (M7.09)", () => {
  it("never reads the real ~/.taskville when a test names no home", async () => {
    const result = await cli(["project", "list"]);
    expect(result.stderr).toContain("No token at");
    expect(result.stderr).not.toContain(join(homedir(), ".taskville"));
  });
});

describe("unreachable error (M7.09)", () => {
  it("a missing token says `taskville start`, never `taskville serve`", async () => {
    const empty = tempDir("taskville-notoken-");
    homes.push(empty);
    const result = await cli(["project", "list", "--home", empty.path]);
    expect(result.stderr).toContain("No token at");
    expect(result.stderr).toContain("taskville start");
    expect(result.stderr).not.toContain("taskville serve");
  });

  it("tells the user to run `taskville start`", async () => {
    const [port] = await freePorts(1);
    const result = await listAt(homeWith(), { args: ["--url", `http://127.0.0.1:${port}`] });
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/unreachable/i);
    expect(result.stderr).toContain("`taskville start`");
  });
});

describe("demo defaults (M7.09)", () => {
  /** An engine stub that records posted batches and says every project is unknown. */
  async function stub() {
    const batches: { events: { projectId: string; sourceId?: string }[] }[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/events/batch") {
          batches.push(JSON.parse(body));
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unknown_project", message: "unknown" } }));
      });
    });
    const [port] = await freePorts(1);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${port}`,
      batches,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const demoArgs = ["--speed", "600", "--duration", "1m"];

  it("bare `taskville demo` runs demo start into unsorted", async () => {
    const engine = await stub();
    try {
      const home = homeWith();
      const controller = new AbortController();
      let out = "";
      const result = await cli(["demo"], {
        cwd: home,
        env: { TASKVILLE_HOME: home, TASKVILLE_URL: engine.url },
        signal: controller.signal,
        stdout: (s) => {
          out += s;
          if (out.includes("Ctrl+C")) setTimeout(() => controller.abort(), 200);
        },
      });
      expect(result.stderr).not.toMatch(/Unknown demo command/);
      expect(out).toMatch(/Demo seed -?\d+ \(calm\) into unsorted at 1x/);
    } finally {
      await engine.close();
    }
  });

  it("`demo` with no subcommand behaves as `demo start`, project unsorted", async () => {
    const engine = await stub();
    try {
      const home = homeWith();
      const result = await cli(["demo", ...demoArgs, "--home", home, "--url", engine.url], {
        cwd: home,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unsorted");
      expect(result.stdout).toMatch(/Demo seed -?\d+/);
      expect(engine.batches.length).toBeGreaterThan(0);
      expect(engine.batches[0]?.events.every((e) => e.projectId === "unsorted")).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it("`demo start` defaults --project to unsorted", async () => {
    const engine = await stub();
    try {
      const home = homeWith();
      const result = await cli(
        ["demo", "start", "--seed", "3", ...demoArgs, "--home", home, "--url", engine.url],
        { cwd: home },
      );
      expect(result.stderr).toContain("unsorted");
      expect(engine.batches[0]?.events.every((e) => e.projectId === "unsorted")).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it("an explicit --project and --seed still win", async () => {
    const engine = await stub();
    try {
      const home = homeWith();
      const result = await cli(
        [
          "demo",
          "start",
          "--project",
          "other",
          "--seed",
          "7",
          ...demoArgs,
          "--home",
          home,
          "--url",
          engine.url,
        ],
        { cwd: home },
      );
      expect(result.stdout).toContain("Demo seed 7");
      expect(engine.batches[0]?.events.every((e) => e.projectId === "other")).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it("picks a random seed, prints it, and the printed seed reproduces the run", async () => {
    const engine = await stub();
    try {
      const home = homeWith();
      const args = ["--home", home, "--url", engine.url];
      const seeds = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const result = await cli(["demo", "start", ...demoArgs, ...args], { cwd: home });
        const seed = /Demo seed (-?\d+)/.exec(result.stdout)?.[1];
        expect(seed).toBeDefined();
        seeds.add(seed as string);
      }
      expect(seeds.size).toBeGreaterThan(1);

      const [printed] = [...seeds];
      const before = engine.batches.length;
      const again = await cli(
        ["demo", "start", "--seed", printed as string, ...demoArgs, ...args],
        {
          cwd: home,
        },
      );
      expect(again.stdout).toContain(`Demo seed ${printed}`);
      expect(engine.batches[before]?.events[0]?.sourceId).toBe(`demo:${printed}`);
    } finally {
      await engine.close();
    }
  });

  it("the random seed is a whole number that --seed accepts", async () => {
    const engine = await stub();
    try {
      const home = homeWith();
      const result = await cli(["demo", ...demoArgs, "--home", home, "--url", engine.url], {
        cwd: home,
      });
      const seed = Number(/Demo seed (-?\d+)/.exec(result.stdout)?.[1]);
      expect(Number.isSafeInteger(seed)).toBe(true);
    } finally {
      await engine.close();
    }
  });
});
