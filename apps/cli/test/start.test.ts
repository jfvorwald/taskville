import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Io, run } from "../src/main.ts";
import { freePort, tempDir } from "./helpers.ts";

// M7.08 (#380): `taskville start`, a quiet terminal, and <home>/engine.json. Red-phase tests.
//
// Seams the implementation must provide (all optional fields on `Io` in src/context.ts, so the
// tests drive `run(argv, io)` in process; src/main.ts fills the real ones):
//   io.stdoutIsTTY?: boolean
//       Whether stdout is a terminal. main.ts passes process.stdout.isTTY. Absent means false.
//       Decides both "open the browser" and "quiet terminal".
//   io.openUrl?: (url: string) => Promise<void>
//       Opens a URL in the default browser (argv-based spawn of open / xdg-open / cmd /c start,
//       never a shell string). Rejects when it fails; `start` then prints the link as today.
//       Called once with the file:// URL (or path) of a redirect page under <home>/run/, never
//       with the pairing URL itself: the code must not reach any argv (process list).
//   io.scheduleCleanup?: (cleanup: () => void) => void
//       Called once after the opener succeeds with a function that deletes the redirect file.
//       main.ts passes a short setTimeout (unref'd); tests capture and call it. Shutdown also
//       deletes the file. Absent means start picks its own short timer.
//   io.sourceCheckout?: boolean
//       True when the CLI runs from a source checkout (build step possible). main.ts derives it.
//   io.buildWeb?: () => Promise<void>
//       Builds the web client once. Called only when the client is missing AND sourceCheckout is
//       true; a one-line notice mentioning "building" goes to stdout or stderr first.
// New command in src/commands/start.ts, registered in main.ts: `start [--port N] [--no-open]
// [--verbose]` plus the global --home. It runs the same engine as `serve --headless`.
// Terminal rules (start, and serve when io.stdoutIsTTY): stdout and stderr carry only a short
// banner (URL, home, pairing hint, "Ctrl-C" to stop) and plain-sentence warnings. Info JSON log
// lines go to <home>/logs/engine.log (file 0600, dir 0700); --verbose also prints them to
// stderr. serve without a TTY keeps writing JSON lines to stderr as before.
// Runtime file (start and serve): <home>/engine.json = {"url","pid","startedAt","keyListener"} (ISO string),
// mode 0600, written on listen, removed on clean shutdown. A live engine is one whose pid is
// alive and whose GET /health answers (any HTTP answer; the file holds no token).

interface Run {
  home: string;
  out: () => string;
  err: () => string;
  opened: string[];
  stop: () => Promise<number>;
  exited: Promise<number>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function launch(
  argv: string[],
  home: string,
  io: Partial<Io> & { openUrl?: Io["openUrl"] } = {},
): Run {
  const controller = new AbortController();
  let out = "";
  let err = "";
  const opened: string[] = [];
  const exited = run(argv, {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: { TASKVILLE_WEB_DIR: join(home, "no-web") },
    cwd: home,
    signal: controller.signal,
    now: () => new Date("2026-11-04T12:00:00Z"),
    sourceCheckout: false,
    openUrl: async (url: string) => {
      opened.push(url);
    },
    ...io,
  } as Io);
  const handle: Run = {
    home,
    out: () => out,
    err: () => err,
    opened,
    exited,
    stop: async () => {
      controller.abort();
      return exited;
    },
  };
  cleanups.push(async () => {
    controller.abort();
    await exited.catch(() => {});
  });
  return handle;
}

const engineJson = (home: string) => join(home, "engine.json");
const readEngine = (home: string) => JSON.parse(readFileSync(engineJson(home), "utf8"));
const mode = (path: string) => statSync(path).mode & 0o777;

/** A temp home with a built-client stand-in, so tests not about the client are not warned. */
function setup() {
  const home = tempDir();
  const web = tempDir("taskville-web-");
  writeFileSync(join(web.path, "index.html"), "<!doctype html><title>Taskville</title>");
  cleanups.push(
    () => home.remove(),
    () => web.remove(),
  );
  return { home: home.path, web: web.path, env: { TASKVILLE_WEB_DIR: web.path } };
}

async function startOn(
  command: string[],
  s: ReturnType<typeof setup>,
  io: Partial<Io> = {},
  extra: string[] = [],
): Promise<{ r: Run; port: number }> {
  const port = await freePort();
  const r = launch(
    [
      ...command,
      "--home",
      s.home,
      "--port",
      String(port),
      ...extra.filter((a) => command[0] === "start" || a !== "--no-open"),
    ],
    s.home,
    {
      env: s.env,
      ...io,
    },
  );
  let done: number | undefined;
  void r.exited.then((code) => {
    done = code;
  });
  await until(() => existsSync(engineJson(s.home)) || done !== undefined, "engine.json");
  if (done !== undefined) {
    throw new Error(`${command.join(" ")} exited ${done} before engine.json: ${r.err().trim()}`);
  }
  return { r, port };
}

const jsonLines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });

describe("start opens the pairing link", () => {
  it("opens a redirect page (not the pairing URL) once through the injected opener on a terminal", async () => {
    const s = setup();
    const { r, port } = await startOn(["start"], s, { stdoutIsTTY: true });
    await until(() => r.opened.length > 0, "opener call");
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]).not.toContain("#pair=");
    expect(redirectFile(s.home, r.opened[0] as string)).toContain(`:${port}/#pair=`);
    expect(await r.stop()).toBe(0);
  });

  it("skips the opener with --no-open and prints the link instead", async () => {
    const s = setup();
    const { r } = await startOn(["start"], s, { stdoutIsTTY: true }, ["--no-open"]);
    await until(() => r.out().includes("#pair="), "printed link");
    expect(r.opened).toEqual([]);
    await r.stop();
    expect(r.opened).toEqual([]);
  });

  it("skips the opener when stdout is not a terminal", async () => {
    const s = setup();
    const { r } = await startOn(["start"], s, { stdoutIsTTY: false });
    await until(() => r.out().includes("#pair="), "printed link");
    expect(r.opened).toEqual([]);
    await r.stop();
    expect(r.opened).toEqual([]);
  });

  it("prints the link when the opener fails", async () => {
    const s = setup();
    const { r } = await startOn(["start"], s, {
      stdoutIsTTY: true,
      openUrl: async () => {
        throw new Error("no browser");
      },
    });
    await until(() => r.out().includes("#pair="), "printed link");
    expect(r.out()).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/);
    expect(await r.stop()).toBe(0);
  });
});

/** The local path of what the opener received (a file:// URL or a path); asserts it is in <home>/run. */
function openedPath(home: string, arg: string): string {
  expect(arg, "the opener must get a file:// URL or an absolute path").toMatch(/^(file:\/\/|\/)/);
  const path = arg.startsWith("file://") ? fileURLToPath(arg) : arg;
  expect(dirname(realpathSync(dirname(path)))).toBe(realpathSync(home));
  expect(basename(dirname(path))).toBe("run");
  return path;
}

/** Reads the redirect page the opener was pointed at. */
function redirectFile(home: string, arg: string): string {
  return readFileSync(openedPath(home, arg), "utf8");
}

describe("the pairing code never reaches the opener's argv (M7.08 security finding)", () => {
  const pageMatches = (html: string) =>
    html.match(/http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/);

  it("opens a file under <home>/run/ whose name and URL do not contain the code", async () => {
    const s = setup();
    const { r } = await startOn(["start"], s, { stdoutIsTTY: true });
    await until(() => r.opened.length > 0, "opener call");
    const arg = r.opened[0] as string;
    const link = pageMatches(redirectFile(s.home, arg));
    expect(link).not.toBeNull();
    const code = (link as RegExpMatchArray)[0].split("#pair=")[1] as string;
    expect(arg).not.toContain(code);
    expect(arg).not.toContain("pair");
    expect(arg).not.toMatch(/^https?:/);
    await r.stop();
  });

  it("writes the page 0600 in a 0700 dir, redirecting without external resources", async () => {
    const s = setup();
    const { r } = await startOn(["start"], s, { stdoutIsTTY: true });
    await until(() => r.opened.length > 0, "opener call");
    const path = openedPath(s.home, r.opened[0] as string);
    expect(mode(path)).toBe(0o600);
    expect(mode(dirname(path))).toBe(0o700);
    const html = readFileSync(path, "utf8");
    expect(html).toMatch(/http-equiv=["']refresh["']/i);
    expect(html).toContain("location.replace");
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=/i);
    await r.stop();
  });

  it("uses an unpredictable name (a second start picks a different file)", async () => {
    const names: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const s = setup();
      const { r } = await startOn(["start"], s, { stdoutIsTTY: true });
      await until(() => r.opened.length > 0, "opener call");
      names.push(basename(openedPath(s.home, r.opened[0] as string)));
      await r.stop();
    }
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toMatch(/[A-Za-z0-9_-]{16,}/);
  });

  it("deletes the page when the injected cleanup trigger fires", async () => {
    const s = setup();
    const triggers: Array<() => void> = [];
    const { r } = await startOn(["start"], s, {
      stdoutIsTTY: true,
      scheduleCleanup: (fn: () => void) => {
        triggers.push(fn);
      },
    });
    await until(() => r.opened.length > 0, "opener call");
    const path = openedPath(s.home, r.opened[0] as string);
    expect(existsSync(path)).toBe(true);
    expect(triggers).toHaveLength(1);
    triggers[0]?.();
    expect(existsSync(path)).toBe(false);
    triggers[0]?.(); // idempotent
    expect(await r.stop()).toBe(0);
  });

  it("deletes the page on shutdown even if the trigger never fires", async () => {
    const s = setup();
    const { r } = await startOn(["start"], s, {
      stdoutIsTTY: true,
      scheduleCleanup: () => {},
    });
    await until(() => r.opened.length > 0, "opener call");
    const path = openedPath(s.home, r.opened[0] as string);
    expect(existsSync(path)).toBe(true);
    expect(await r.stop()).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("prints the link and never calls the opener when the page cannot be written", async () => {
    const s = setup();
    writeFileSync(join(s.home, "run"), "not a directory"); // <home>/run cannot be created
    const { r } = await startOn(["start"], s, { stdoutIsTTY: true });
    await until(() => r.out().includes("#pair=") || r.opened.length > 0, "link or opener call");
    expect(r.opened).toEqual([]);
    expect(r.out()).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/);
    expect(await r.stop()).toBe(0);
  });
});

describe("a quiet terminal", () => {
  for (const command of [["start"], ["serve", "--headless"]]) {
    it(`${command[0]} on a terminal prints a banner and no JSON log lines; the log file gets them`, async () => {
      const s = setup();
      const { r, port } = await startOn(command, s, { stdoutIsTTY: true }, ["--no-open"]);
      await fetch(`http://127.0.0.1:${port}/health`).catch(() => {});
      const log = join(s.home, "logs", "engine.log");
      await until(() => existsSync(log) && readFileSync(log, "utf8").includes("{"), "log lines");
      expect(await r.stop()).toBe(0);
      expect(jsonLines(r.out())).toEqual([]);
      expect(jsonLines(r.err())).toEqual([]);
      expect(r.out()).toContain(`http://127.0.0.1:${port}`);
      expect(r.out()).toContain(s.home);
      expect(r.out()).toContain("Ctrl-C");
      const lines = jsonLines(readFileSync(log, "utf8"));
      expect(lines.length).toBeGreaterThan(0);
      expect(mode(log)).toBe(0o600);
      expect(mode(join(s.home, "logs"))).toBe(0o700);
    });
  }

  it("--verbose also prints the JSON lines, and the file still gets them", async () => {
    const s = setup();
    const { r, port } = await startOn(["start"], s, { stdoutIsTTY: true }, [
      "--no-open",
      "--verbose",
    ]);
    await fetch(`http://127.0.0.1:${port}/health`).catch(() => {});
    await until(() => jsonLines(r.out() + r.err()).length > 0, "printed JSON lines");
    await r.stop();
    expect(
      jsonLines(readFileSync(join(s.home, "logs", "engine.log"), "utf8")).length,
    ).toBeGreaterThan(0);
  });

  it("serve without a terminal keeps JSON lines on stderr", async () => {
    const s = setup();
    const { r, port } = await startOn(["serve", "--headless"], s, { stdoutIsTTY: false });
    await fetch(`http://127.0.0.1:${port}/health`).catch(() => {});
    await until(() => jsonLines(r.err()).length > 0, "JSON lines on stderr");
    await r.stop();
    expect(jsonLines(r.out())).toEqual([]);
  });
});

describe("<home>/engine.json", () => {
  for (const command of [["start"], ["serve", "--headless"]]) {
    it(`${command[0]} writes it 0600 on listen and removes it on clean shutdown`, async () => {
      const s = setup();
      const { r, port } = await startOn(command, s, { stdoutIsTTY: false }, ["--no-open"]);
      await until(() => {
        try {
          readEngine(s.home);
          return true;
        } catch {
          return false;
        }
      }, "complete engine.json");
      const info = readEngine(s.home);
      expect(Object.keys(info).sort()).toEqual(["keyListener", "pid", "startedAt", "url"]);
      expect(info.url).toBe(`http://127.0.0.1:${port}`);
      expect(info.pid).toBe(process.pid);
      expect(Number.isNaN(Date.parse(info.startedAt))).toBe(false);
      expect(mode(engineJson(s.home))).toBe(0o600);
      expect(await r.stop()).toBe(0);
      expect(existsSync(engineJson(s.home))).toBe(false);
    });
  }
});

describe("an engine already running", () => {
  let health: ReturnType<typeof createHttpServer> | undefined;
  afterEach(() => {
    health?.close();
    health = undefined;
  });

  async function fakeEngine(home: string, pid: number) {
    health = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    });
    const server = health;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const livePort = typeof address === "object" && address !== null ? address.port : 0;
    const info = {
      url: `http://127.0.0.1:${livePort}`,
      pid,
      startedAt: "2026-11-04T11:00:00.000Z",
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(engineJson(home), JSON.stringify(info), { mode: 0o600 });
    return info;
  }

  it("a second start prints the live URL and the p hint, exits 0, and binds nothing", async () => {
    const s = setup();
    const info = await fakeEngine(s.home, process.pid);
    const spare = await freePort();
    const r = launch(["start", "--home", s.home, "--port", String(spare)], s.home, {
      env: s.env,
      stdoutIsTTY: true,
    });
    expect(await r.exited).toBe(0);
    expect(r.out()).toContain(info.url);
    expect(r.out().toLowerCase()).toContain("press p");
    expect(r.opened).toEqual([]);
    expect(readEngine(s.home)).toEqual(info);
    await expect(fetch(`http://127.0.0.1:${spare}/health`)).rejects.toThrow();
  });

  it("a stale engine.json (dead pid) does not block a new start, which replaces it", async () => {
    const s = setup();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    const old = await fakeEngine(s.home, dead);
    const { r, port } = await startOn(["start"], s, { stdoutIsTTY: false }, ["--no-open"]);
    await until(() => readEngine(s.home).url === `http://127.0.0.1:${port}`, "new engine.json");
    expect(readEngine(s.home).url).not.toBe(old.url);
    expect(await r.stop()).toBe(0);
  });
});

describe("the web client", () => {
  it("builds it once, with a one-line notice, when missing in a source checkout", async () => {
    const s = setup();
    const missing = join(s.home, "web-dist");
    let builds = 0;
    const port = await freePort();
    const r = launch(["start", "--home", s.home, "--port", String(port), "--no-open"], s.home, {
      env: { TASKVILLE_WEB_DIR: missing },
      stdoutIsTTY: true,
      sourceCheckout: true,
      buildWeb: async () => {
        builds += 1;
        mkdirSync(missing, { recursive: true });
        writeFileSync(join(missing, "index.html"), "<title>Built</title>");
      },
    });
    await until(() => existsSync(engineJson(s.home)), "engine.json");
    expect(builds).toBe(1);
    const notice = (r.out() + r.err()).split("\n").filter((l) => /building/i.test(l));
    expect(notice).toHaveLength(1);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(await page.text()).toContain("Built");
    await r.stop();
  });

  it("does not build when the client is already there", async () => {
    const s = setup();
    let builds = 0;
    const { r } = await startOn(
      ["start"],
      s,
      {
        stdoutIsTTY: true,
        sourceCheckout: true,
        buildWeb: async () => {
          builds += 1;
        },
      },
      ["--no-open"],
    );
    await r.stop();
    expect(builds).toBe(0);
  });

  it("outside a checkout fails with one sentence and does not build or listen", async () => {
    const s = setup();
    let builds = 0;
    const port = await freePort();
    const r = launch(["start", "--home", s.home, "--port", String(port), "--no-open"], s.home, {
      env: { TASKVILLE_WEB_DIR: join(s.home, "missing") },
      stdoutIsTTY: true,
      sourceCheckout: false,
      buildWeb: async () => {
        builds += 1;
      },
    });
    expect(await r.exited).not.toBe(0);
    expect(builds).toBe(0);
    const sentences = r.err().trim().split("\n");
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatch(/web client/i);
    expect(existsSync(engineJson(s.home))).toBe(false);
  });
});

describe("a port taken by something else", () => {
  it("fails with one sentence naming the port and --port", async () => {
    const s = setup();
    const taken = await new Promise<{ server: Server; port: number }>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        resolve({ server, port: typeof a === "object" && a !== null ? a.port : 0 });
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => taken.server.close(() => resolve())));
    const r = launch(
      ["start", "--home", s.home, "--port", String(taken.port), "--no-open"],
      s.home,
      {
        env: s.env,
        stdoutIsTTY: true,
      },
    );
    expect(await r.exited).not.toBe(0);
    const lines = r.err().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(String(taken.port));
    expect(lines[0]).toContain("--port");
    expect(existsSync(engineJson(s.home))).toBe(false);
  });
});
