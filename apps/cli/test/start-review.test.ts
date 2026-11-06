import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Io, openerCommand, run } from "../src/main.ts";
import { freePort, tempDir } from "./helpers.ts";

// M7.08 (#380) review round, red phase. Seams added beyond the first round:
//   io.scheduleCleanup?: (cleanup: () => void, delayMs: number) => void
//       start passes the delay; the default is the pairing code TTL (PAIRING_CODE_TTL_MS, 10
//       minutes in this repo: the ticket said 5, the constant says 10; the test follows the constant).
//   buildWeb rejects with an Error that carries a string `stderr` property (the build's captured
//       stderr). start puts the last lines of it into the CliError message. No other seam change.
//   main.ts exports the pure `openerCommand(platform, url): { command: string; args: string[] }`.
//   Real signal wiring (SIGHUP) is tested by spawning `node src/main.ts` as a child process.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function setup() {
  const home = tempDir();
  const web = tempDir("taskville-web-");
  writeFileSync(join(web.path, "index.html"), "<!doctype html><title>Taskville</title>");
  cleanups.push(
    () => home.remove(),
    () => web.remove(),
  );
  return { home: home.path, env: { TASKVILLE_WEB_DIR: web.path } };
}

const engineJson = (home: string) => join(home, "engine.json");

interface Launched {
  out: () => string;
  err: () => string;
  exited: Promise<number>;
  stop: () => Promise<number>;
  port: number;
}

async function launch(
  argv: string[],
  s: ReturnType<typeof setup>,
  io: Partial<Io> = {},
  waitFor: "engine" | "exit" = "engine",
): Promise<Launched> {
  const port = await freePort();
  const controller = new AbortController();
  let out = "";
  let err = "";
  const exited = run([...argv, "--home", s.home, "--port", String(port)], {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    env: s.env,
    cwd: s.home,
    signal: controller.signal,
    sourceCheckout: false,
    ...io,
  });
  cleanups.push(async () => {
    controller.abort();
    await exited.catch(() => {});
  });
  const l: Launched = {
    out: () => out,
    err: () => err,
    exited,
    port,
    stop: async () => {
      controller.abort();
      return exited;
    },
  };
  if (waitFor === "engine") {
    let done = false;
    void exited.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await until(() => existsSync(engineJson(s.home)) || done, "engine.json");
  }
  return l;
}

const PAIR_URL = /^http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+$/;

describe("1. opener honesty", () => {
  it("after a successful open, prints a fallback line and then the link on its own line", async () => {
    const s = setup();
    const r = await launch(["start"], s, { stdoutIsTTY: true, openUrl: async () => {} });
    await until(() => r.out().includes("#pair="), "fallback link");
    const lines = r.out().split("\n");
    const at = lines.indexOf("If no browser opened, open this link:");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toMatch(PAIR_URL);
    await r.stop();
  });
});

describe("2. serve without a terminal", () => {
  it("prints the old restart line exactly, with nothing appended", async () => {
    const s = setup();
    const r = await launch(["serve", "--headless"], s, { stdoutIsTTY: false });
    await until(() => r.out().includes("restart"), "restart line");
    expect(r.out().split("\n")).toContain("For a new pairing link later, restart taskville serve.");
    await r.stop();
  });
});

describe("3 and 5. an engine already running", () => {
  let health: Server | undefined;
  afterEach(() => {
    health?.close();
    health = undefined;
  });

  async function fakeEngine(home: string, pid = process.pid) {
    health = createHttpServer((_req, res) => res.end('{"status":"ok"}'));
    const server = health;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const a = server.address();
    const url = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
    mkdirSync(home, { recursive: true });
    writeFileSync(
      engineJson(home),
      JSON.stringify({ url, pid, startedAt: "2026-11-04T11:00:00.000Z" }),
      { mode: 0o600 },
    );
    return url;
  }

  for (const command of [["start"], ["serve", "--headless"]]) {
    it(`${command[0]}: says to press p only in an engine terminal that has one, or restart it`, async () => {
      const s = setup();
      const url = await fakeEngine(s.home);
      const r = await launch(command, s, { stdoutIsTTY: true }, "exit");
      expect(await r.exited).toBe(0);
      expect(r.out()).toContain(url);
      for (const line of r.out().split("\n")) expect(line).not.toMatch(/^\s*Press p/i);
      expect(r.out()).toMatch(/restart/i);
      expect(r.out()).toMatch(/\bp\b/);
      await expect(fetch(`http://127.0.0.1:${r.port}/health`)).rejects.toThrow();
    });
  }
});

describe("4. web build failures", () => {
  it("surfaces the last lines of the build's stderr in the error", async () => {
    const s = setup();
    const missing = join(s.home, "web-dist");
    const stderr = Array.from({ length: 100 }, (_, i) => `build-line-${i + 1}`).join("\n");
    const r = await launch(
      ["start", "--no-open"],
      { ...s, env: { TASKVILLE_WEB_DIR: missing } },
      {
        stdoutIsTTY: true,
        sourceCheckout: true,
        buildWeb: async () => {
          throw Object.assign(new Error("pnpm build exited with code 1"), { stderr });
        },
      },
      "exit",
    );
    expect(await r.exited).not.toBe(0);
    expect(r.err()).toContain("build-line-100");
    expect(r.err()).toContain("build-line-95");
    expect(r.err()).not.toContain("build-line-1\n");
    expect(r.err()).not.toContain("build-line-50\n");
    expect(existsSync(engineJson(s.home))).toBe(false);
  });

  it("a build that succeeds but leaves no index.html fails with one clear sentence", async () => {
    const s = setup();
    const missing = join(s.home, "web-dist");
    const r = await launch(
      ["start", "--no-open"],
      { ...s, env: { TASKVILLE_WEB_DIR: missing } },
      { stdoutIsTTY: true, sourceCheckout: true, buildWeb: async () => {} },
      "exit",
    );
    expect(await r.exited).not.toBe(0);
    const lines = r.err().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("index.html");
    expect(existsSync(engineJson(s.home))).toBe(false);
  });
});

describe("5. cleanup", () => {
  it("removes engine.json when printing the link fails after listening (serve)", async () => {
    const s = setup();
    const r = await launch(
      ["serve", "--headless"],
      s,
      {
        stdout: (t: string) => {
          if (t.includes("#pair=")) throw new Error("stdout closed");
        },
      },
      "exit",
    );
    expect(await r.exited).toBe(1);
    expect(existsSync(engineJson(s.home))).toBe(false);
  });

  it("removes engine.json when the keys hint cannot be printed (serve)", async () => {
    const s = setup();
    const r = await launch(
      ["serve", "--headless"],
      s,
      {
        stdout: (t: string) => {
          if (t.startsWith("For a new pairing link later")) throw new Error("stdout closed");
        },
      },
      "exit",
    );
    expect(await r.exited).toBe(1);
    expect(existsSync(engineJson(s.home))).toBe(false);
  });

  it("removes the redirect file when the opener fails", async () => {
    const s = setup();
    const r = await launch(["start"], s, {
      stdoutIsTTY: true,
      openUrl: async () => {
        throw new Error("no browser");
      },
    });
    await until(() => r.out().includes("#pair="), "printed link");
    const run = join(s.home, "run");
    expect(existsSync(run) ? readdirSync(run) : []).toEqual([]);
    await r.stop();
  });

  it("does not delete an engine.json whose pid is another process", async () => {
    const s = setup();
    const r = await launch(["serve", "--headless"], s, { stdoutIsTTY: false });
    const other = {
      url: "http://127.0.0.1:9",
      pid: process.ppid,
      startedAt: "2026-11-04T11:00:00Z",
    };
    writeFileSync(engineJson(s.home), JSON.stringify(other));
    expect(await r.stop()).toBe(0);
    expect(JSON.parse(readFileSync(engineJson(s.home), "utf8"))).toEqual(other);
  });
});

describe("6. engine.json is untrusted input", () => {
  let recorder: Server | undefined;
  let requests: string[] = [];
  afterEach(() => {
    recorder?.close();
    recorder = undefined;
    requests = [];
  });

  async function recording(): Promise<number> {
    recorder = createHttpServer((req, res) => {
      requests.push(req.url ?? "");
      res.end("{}");
    });
    const server = recorder;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const a = server.address();
    return typeof a === "object" && a !== null ? a.port : 0;
  }

  const badUrls: Array<[string, (p: number) => string]> = [
    ["a path", (p) => `http://127.0.0.1:${p}/evil`],
    ["a query", (p) => `http://127.0.0.1:${p}?x=1`],
    ["user info", (p) => `http://user@127.0.0.1:${p}`],
    ["https", (p) => `https://127.0.0.1:${p}`],
    ["a lookalike host", (p) => `http://127.0.0.1.localtest.invalid:${p}`],
  ];
  for (const [label, make] of badUrls) {
    it(`ignores an engine.json whose url has ${label}: no request, never printed`, async () => {
      const s = setup();
      const live = await recording();
      const url = make(live);
      writeFileSync(
        engineJson(s.home),
        JSON.stringify({ url, pid: process.pid, startedAt: "2026-11-04T11:00:00Z" }),
      );
      const r = await launch(["start", "--no-open"], s, { stdoutIsTTY: true });
      await until(() => r.out().includes("#pair="), "a fresh engine");
      expect(r.out()).not.toContain(url);
      expect(r.out()).not.toMatch(/already running/i);
      expect(requests).toEqual([]);
      await r.stop();
    });
  }

  for (const pid of [0, -1, 1.5, 2 ** 31, "123", null]) {
    it(`ignores an engine.json whose pid is ${JSON.stringify(pid)}`, async () => {
      const s = setup();
      const live = await recording();
      const url = `http://127.0.0.1:${live}`;
      writeFileSync(
        engineJson(s.home),
        JSON.stringify({ url, pid, startedAt: "2026-11-04T11:00:00Z" }),
      );
      const r = await launch(["start", "--no-open"], s, { stdoutIsTTY: true });
      await until(() => r.out().includes("#pair="), "a fresh engine");
      expect(r.out()).not.toMatch(/already running/i);
      expect(requests).toEqual([]);
      await r.stop();
    });
  }
});

describe("6. openerCommand", () => {
  it("uses open on darwin and xdg-open on linux, with the URL as one argument", () => {
    const url = "file:///tmp/x/run/abc.html";
    expect(openerCommand("darwin", url)).toEqual({ command: "open", args: [url] });
    expect(openerCommand("linux", url)).toEqual({ command: "xdg-open", args: [url] });
  });

  it("on win32 uses rundll32 with the URL as one argument, never cmd.exe", () => {
    const url = "file:///C:/Users/A%20B%20C/.tv/run/a&b(1)^!,;=.html";
    expect(openerCommand("win32", url)).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("on win32 passes a URL with several %20 and & through unchanged (no cmd percent expansion)", () => {
    const url = "file:///C:/Users/Jane%20Q%20Doe/.tv/run/p.html?a=1&b=2";
    const got = openerCommand("win32", url);
    expect(got.command).not.toMatch(/cmd/i);
    expect(got.args).not.toContain("/c");
    expect(got.args[got.args.length - 1]).toBe(url);
  });
});

describe("7. SIGHUP", () => {
  it("stops the engine cleanly like SIGTERM: exit 0, engine.json removed", async () => {
    const s = setup();
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "..", "src", "main.ts"),
        "serve",
        "--headless",
        "--home",
        s.home,
        "--port",
        String(port),
      ],
      { env: { ...process.env, TASKVILLE_WEB_DIR: s.env.TASKVILLE_WEB_DIR }, stdio: "ignore" },
    );
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    cleanups.push(() => void child.kill("SIGKILL"));
    await until(() => existsSync(engineJson(s.home)), "engine.json", 30_000);
    child.kill("SIGHUP");
    expect(await exit).toEqual({ code: 0, signal: null });
    expect(existsSync(engineJson(s.home))).toBe(false);
  }, 60_000);
});
