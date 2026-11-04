// M7.09: the CLI finds the running engine from <home>/engine.json (written by M7.08) and
// `taskville demo` works with no flags. Seam: `Io.isAlive?: (pid: number) => boolean` decides
// whether engine.json's pid is alive; tests inject it so nothing depends on real processes.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cli, freePort, tempDir } from "./helpers.ts";

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

describe("URL resolution (M7.09)", () => {
  it("uses --url before everything else", async () => {
    const [a, b, c] = [await freePort(), await freePort(), await freePort()];
    const home = homeWith(record(`http://127.0.0.1:${c}`));
    const result = await listAt(home, {
      args: ["--url", `http://127.0.0.1:${a}`],
      env: { TASKVILLE_URL: `http://127.0.0.1:${b}` },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`127.0.0.1:${a}`);
  });

  it("uses $TASKVILLE_URL before engine.json", async () => {
    const [b, c] = [await freePort(), await freePort()];
    const home = homeWith(record(`http://127.0.0.1:${c}`));
    const result = await listAt(home, { env: { TASKVILLE_URL: `http://127.0.0.1:${b}` } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`127.0.0.1:${b}`);
  });

  it.each(["127.0.0.1", "localhost"])("uses engine.json for %s with a live pid", async (host) => {
    const port = await freePort();
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

  it("falls back to the default 4807 with no engine.json", async () => {
    const result = await listAt(homeWith());
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("127.0.0.1:4807");
  });

  it("ignores engine.json when its pid is stale", async () => {
    const port = await freePort();
    const result = await listAt(homeWith(record(`http://127.0.0.1:${port}`)), { isAlive: dead });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("127.0.0.1:4807");
    expect(result.stderr).not.toContain(String(port));
  });

  it.each([
    "http://evil.example:4807",
    "http://127.0.0.1.evil.example:4807",
    "http://localhost.evil.example:4807",
    "https://127.0.0.1:4807",
    "http://user:pass@127.0.0.1:4807",
    "http://127.0.0.1@evil.example:4807",
    "http://evil.example:4807@127.0.0.1:4807",
    "http://0.0.0.0:4807",
    "http://127.0.0.1",
    "ftp://127.0.0.1:4807",
    "not a url",
    "",
  ])("ignores engine.json with the url %j", async (url) => {
    const result = await listAt(homeWith(record(url)));
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("127.0.0.1:4807");
    expect(result.stderr).not.toMatch(/evil|user:pass/);
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
  ])("ignores engine.json that is %s", async (_name, text) => {
    const result = await listAt(homeWith(text));
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("127.0.0.1:4807");
    expect(result.stderr).not.toContain("5001");
  });
});

describe("unreachable error (M7.09)", () => {
  it("tells the user to run `taskville start`", async () => {
    const port = await freePort();
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
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${port}`,
      batches,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const demoArgs = ["--speed", "600", "--duration", "1m"];

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
