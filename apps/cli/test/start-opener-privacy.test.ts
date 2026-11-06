import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { PAIRING_CODE_TTL_MS } from "@taskville/engine/src/auth/pairing.ts";
import { afterEach, describe, expect, it } from "vitest";
import { appleScriptOpenLocation, type Io, openUrl, run } from "../src/main.ts";
import { freePort, tempDir } from "./helpers.ts";

// M7.19 (#400), roborev 7127 (high): the one-time pairing code must never be on a child
// process's argv (another local OS user can read it).
//
// Seams the implementation must provide:
//   io.platform?: string                 (src/context.ts) defaults to process.platform.
//       serve/start on "darwin" hand io.openUrl the http pairing link (the real opener keeps it
//       off argv, see below). On any other platform they restore the M7.08 behaviour: write a
//       0600 redirect page in the 0700 <home>/run dir and hand io.openUrl only its file:// URL,
//       with scheduleCleanup(remove, PAIRING_CODE_TTL_MS), removal on shutdown, a sweep of stale
//       run/*.html on start, and a printed link when the page cannot be written.
//   main.ts exports appleScriptOpenLocation(url: string): string
//       -> `open location "<url>"` with backslash and double quote escaped for an AppleScript string.
//   main.ts exports openUrl(url, platform = process.platform, spawnFn = spawn): Promise<void>
//       darwin: spawnFn("osascript", ["-"], opts with a piped stdin); writes the script to the
//       child's stdin and ends it; argv holds no URL. Resolves on exit 0, rejects otherwise.
//       other platforms: spawnFn(openerCommand(platform, url)...) as before.
//   openerCommand("darwin", url) must not put the URL in args.

const CODE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";
const HTTP = `http://127.0.0.1:4455/#pair=${CODE}&keys=1`;

function fakeSpawn(exitCode = 0) {
  const calls: Array<{ command: string; args: string[]; options: unknown; stdin: string }> = [];
  const spawnFn = ((command: string, args: string[], options: unknown) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; unref: () => void };
    const call = { command, args, options, stdin: "" };
    calls.push(call);
    child.stdin = new PassThrough();
    child.stdin.on("data", (d: Buffer) => {
      call.stdin += d.toString();
    });
    child.stdin.on("end", () => setImmediate(() => child.emit("close", exitCode)));
    child.unref = () => {};
    if (command !== "osascript") setImmediate(() => child.emit("close", exitCode));
    return child;
  }) as never;
  return { calls, spawnFn };
}

describe("appleScriptOpenLocation", () => {
  it("builds an open location statement around the URL", () => {
    expect(appleScriptOpenLocation(HTTP)).toBe(`open location "${HTTP}"`);
  });
  it("escapes backslash and double quote so the string literal cannot be broken", () => {
    const script = appleScriptOpenLocation('http://x/#a"b\\c" & (do shell script "id")');
    expect(script).toBe('open location "http://x/#a\\"b\\\\c\\" & (do shell script \\"id\\")"');
  });
});

describe("openUrl on darwin (roborev 7127)", () => {
  it("runs osascript with the script on stdin and no URL or code in argv", async () => {
    const { calls, spawnFn } = fakeSpawn();
    await openUrl(HTTP, "darwin", spawnFn);
    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[number];
    expect(call.command).toBe("osascript");
    const argv = [call.command, ...call.args].join("\0");
    expect(argv).not.toContain(CODE);
    expect(argv).not.toContain("pair");
    expect(argv).not.toContain("http");
    expect(call.stdin).toContain("open location");
    expect(call.stdin).toContain(HTTP);
  });
  it("rejects when osascript exits nonzero so the link is printed instead", async () => {
    const { spawnFn } = fakeSpawn(1);
    await expect(openUrl(HTTP, "darwin", spawnFn)).rejects.toThrow();
  });
});

describe("openUrl off darwin", () => {
  it("uses the platform opener with the (file) URL as argv", async () => {
    const { calls, spawnFn } = fakeSpawn();
    await openUrl("file:///tmp/h/run/x.html", "linux", spawnFn);
    expect(calls[0]?.command).toBe("xdg-open");
    expect(calls[0]?.args).toEqual(["file:///tmp/h/run/x.html"]);
  });
});

// ---- start on a non-darwin platform: the M7.08 redirect page returns ----

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

async function launch(s: ReturnType<typeof setup>, io: Partial<Io> = {}) {
  const port = await freePort();
  const controller = new AbortController();
  let out = "";
  const opened: string[] = [];
  const exited = run(["start", "--home", s.home, "--port", String(port)], {
    stdout: (t) => {
      out += t;
    },
    stderr: () => {},
    env: s.env,
    cwd: s.home,
    signal: controller.signal,
    now: () => new Date("2026-11-04T12:00:00Z"),
    sourceCheckout: false,
    stdoutIsTTY: true,
    platform: "linux",
    openUrl: async (url: string) => {
      opened.push(url);
    },
    ...io,
  } as Io);
  cleanups.push(async () => {
    controller.abort();
    await exited.catch(() => {});
  });
  await until(
    () => existsSync(join(s.home, "engine.json")) && (opened.length > 0 || out.includes("#pair=")),
    "engine and link",
  );
  return {
    opened,
    out: () => out,
    port,
    stop: () => {
      controller.abort();
      return exited;
    },
  };
}

const mode = (path: string) => statSync(path).mode & 0o777;

function pagePath(home: string, arg: string): string {
  expect(arg, "the opener must get a file:// URL").toMatch(/^file:\/\//);
  const path = fileURLToPath(arg);
  expect(basename(dirname(path))).toBe("run");
  expect(dirname(dirname(path))).toContain(basename(home));
  return path;
}

describe("start off darwin opens a redirect page, never the code (M7.08 restored)", () => {
  it("gives the opener a file:// URL under <home>/run/ with no code or pair in it", async () => {
    const s = setup();
    const r = await launch(s);
    const arg = r.opened[0] as string;
    const html = readFileSync(pagePath(s.home, arg), "utf8");
    const link = html.match(/http:\/\/127\.0\.0\.1:\d+\/#pair=([A-Za-z0-9_-]+)/);
    expect(link).not.toBeNull();
    const code = (link as RegExpMatchArray)[1] as string;
    expect(arg).not.toContain(code);
    expect(arg).not.toContain("pair");
    expect(arg).not.toMatch(/^https?:/);
    expect(r.opened).toHaveLength(1);
    await r.stop();
  });

  it("writes the page 0600 in a 0700 dir, redirecting without external resources", async () => {
    const s = setup();
    const r = await launch(s);
    const path = pagePath(s.home, r.opened[0] as string);
    expect(mode(path)).toBe(0o600);
    expect(mode(dirname(path))).toBe(0o700);
    const html = readFileSync(path, "utf8");
    expect(html).toContain("location.replace");
    expect(html).toMatch(/<noscript>\s*<meta[^>]*http-equiv=["']refresh["'][^>]*>\s*<\/noscript>/i);
    expect(html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, "")).not.toMatch(/http-equiv/i);
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=/i);
    await r.stop();
  });

  it("uses an unpredictable name", async () => {
    const names: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const s = setup();
      const r = await launch(s);
      names.push(basename(pagePath(s.home, r.opened[0] as string)));
      await r.stop();
    }
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toMatch(/[A-Za-z0-9_-]{16,}/);
  });

  it("schedules cleanup after the pairing code TTL, and the trigger deletes the page", async () => {
    const s = setup();
    const calls: Array<[() => void, number]> = [];
    const r = await launch(s, {
      scheduleCleanup: ((fn: () => void, ms: number) => {
        calls.push([fn, ms]);
      }) as never,
    });
    await until(() => calls.length > 0, "scheduleCleanup call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe(PAIRING_CODE_TTL_MS);
    const path = pagePath(s.home, r.opened[0] as string);
    expect(existsSync(path)).toBe(true);
    calls[0]?.[0]();
    expect(existsSync(path)).toBe(false);
    calls[0]?.[0]();
    expect(await r.stop()).toBe(0);
  });

  it("deletes the page on shutdown even if the trigger never fires", async () => {
    const s = setup();
    const r = await launch(s, { scheduleCleanup: () => {} });
    const path = pagePath(s.home, r.opened[0] as string);
    expect(existsSync(path)).toBe(true);
    expect(await r.stop()).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("prints the link and never calls the opener when the page cannot be written", async () => {
    const s = setup();
    writeFileSync(join(s.home, "run"), "not a directory");
    const r = await launch(s);
    expect(r.opened).toEqual([]);
    expect(r.out()).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/);
    expect(await r.stop()).toBe(0);
  });

  it("sweeps run/*.html older than the code TTL on start and keeps newer and other files", async () => {
    const s = setup();
    const { mkdirSync, utimesSync } = await import("node:fs");
    const dir = join(s.home, "run");
    mkdirSync(dir, { mode: 0o700 });
    const stale = join(dir, "stale.html");
    const fresh = join(dir, "fresh.html");
    const other = join(dir, "notes.txt");
    for (const f of [stale, fresh, other]) writeFileSync(f, "x", { mode: 0o600 });
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, hourAgo, hourAgo);
    utimesSync(other, hourAgo, hourAgo);
    const r = await launch(s);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    await r.stop();
  });

  it("on darwin writes no page and hands the http link to the injected opener", async () => {
    const s = setup();
    const r = await launch(s, { platform: "darwin" });
    expect(r.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#pair=/);
    const dir = join(s.home, "run");
    expect(existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".html")) : []).toEqual([]);
    await r.stop();
  });
});
