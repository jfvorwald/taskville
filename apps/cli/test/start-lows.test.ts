import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Io, run } from "../src/main.ts";
import { freePort, tempDir } from "./helpers.ts";

// M7.16 (#393) deferred lows from M7.08, red phase. Seams pinned here:
//   - logs/ and run/ go through the same private-directory check as the home (no symlink, owner
//     only), and engine.log is opened without following a symlink.
//   - On start, run/*.html older than the pairing code TTL (10 minutes) is deleted; newer files
//     and other file names stay.
//   - A start finding engine.log over 10 MiB moves it to engine.log.1 and starts a fresh,
//     small engine.log.
//   - engine.json gains `keyListener: boolean`, true when the engine reads the p key. The
//     "already running" text names the p key only when that is true; otherwise it says to
//     restart the engine.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
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
const readRuntime = (home: string) => JSON.parse(readFileSync(engineJson(home), "utf8"));
const written = (home: string) => {
  try {
    return typeof readRuntime(home).url === "string";
  } catch {
    return false;
  }
};

interface Run {
  out: () => string;
  err: () => string;
  exited: Promise<number>;
  stop: () => Promise<number>;
}

async function launch(
  s: ReturnType<typeof setup>,
  io: Partial<Io> = {},
  flags: string[] = ["--no-open"],
): Promise<Run> {
  const port = await freePort();
  const controller = new AbortController();
  let out = "";
  let err = "";
  const exited = run(["start", ...flags, "--home", s.home, "--port", String(port)], {
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
  return {
    out: () => out,
    err: () => err,
    exited,
    stop: async () => {
      controller.abort();
      return exited;
    },
  };
}

/** Waits for the engine to write engine.json, or for an early exit (which is reported). */
async function booted(r: Run, s: ReturnType<typeof setup>): Promise<void> {
  let early: number | undefined;
  void r.exited.then(
    (code) => {
      early = code;
    },
    () => {
      early = -1;
    },
  );
  await until(() => early !== undefined || written(s.home), "engine.json");
  if (early !== undefined) throw new Error(`exited ${early} early: ${r.err().trim()}`);
}

describe("logs/ and run/ are private directories (M7.08 low)", () => {
  it("refuses a logs/ that is a symlink and writes nothing through it", async () => {
    const s = setup();
    const target = tempDir("taskville-elsewhere-");
    cleanups.push(() => target.remove());
    symlinkSync(target.path, join(s.home, "logs"));
    const r = await launch(s);
    const early = await Promise.race([
      r.exited.catch(() => 1),
      until(() => written(s.home), "engine.json").then(() => undefined),
    ]);
    await r.stop().catch(() => 1);
    expect(early).toBe(1);
    expect(r.err()).toMatch(/symlink/);
    expect(existsSync(join(target.path, "engine.log"))).toBe(false);
  });

  it("does not write the pairing page through a run/ symlink", async () => {
    const s = setup();
    const target = tempDir("taskville-elsewhere-");
    cleanups.push(() => target.remove());
    symlinkSync(target.path, join(s.home, "run"));
    const opened: string[] = [];
    const r = await launch(
      s,
      {
        stdoutIsTTY: true,
        openUrl: async (url: string) => {
          opened.push(url);
        },
      },
      [],
    );
    await until(() => written(s.home), "engine.json");
    await until(() => r.out().includes("Press p") || r.out().includes("Ctrl-C"), "banner");
    const inTarget = readdirSync(target.path);
    await r.stop();
    expect(inTarget).toEqual([]);
  });

  it("does not follow a symlinked engine.log", async () => {
    const s = setup();
    const victim = tempDir("taskville-victim-");
    cleanups.push(() => victim.remove());
    const file = join(victim.path, "precious.txt");
    writeFileSync(file, "keep\n", { mode: 0o644 });
    mkdirSync(join(s.home, "logs"), { mode: 0o700 });
    symlinkSync(file, join(s.home, "logs", "engine.log"));
    const r = await launch(s);
    await Promise.race([r.exited.catch(() => 1), until(() => written(s.home), "engine.json")]);
    await r.stop().catch(() => 1);
    expect(readFileSync(file, "utf8")).toBe("keep\n");
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });
});

describe("start cleans up after itself (M7.08 low)", () => {
  it("rotates an engine.log over 10 MiB to engine.log.1 and starts a small one", async () => {
    const s = setup();
    const logs = join(s.home, "logs");
    mkdirSync(logs, { mode: 0o700 });
    writeFileSync(join(logs, "engine.log"), Buffer.alloc(11 * 1024 * 1024, 0x61), { mode: 0o600 });
    const r = await launch(s);
    await booted(r, s);
    expect(statSync(join(logs, "engine.log.1")).size).toBe(11 * 1024 * 1024);
    expect(statSync(join(logs, "engine.log")).size).toBeLessThan(1024 * 1024);
    await r.stop();
  });
});

/** A terminal stdin that accepts raw mode, so the engine listens for keys. */
function fakeTerminal() {
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode: (raw: boolean) => void;
    resume: () => void;
    pause: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  return stdin;
}

describe("engine.json records whether the engine has a key listener (M7.08 low)", () => {
  it("is false without a terminal, and the second start says to restart", async () => {
    const s = setup();
    const first = await launch(s);
    await booted(first, s);
    expect(readRuntime(s.home).keyListener).toBe(false);
    const second = await launch(s);
    expect(await second.exited).toBe(0);
    expect(second.out()).toMatch(/already running/i);
    expect(second.out()).toMatch(/restart/i);
    expect(second.out()).not.toMatch(/press p/i);
    await first.stop();
  });

  it("is true with a terminal, and the second start names the p key", async () => {
    const s = setup();
    const first = await launch(s, { stdin: fakeTerminal(), stdoutIsTTY: true });
    await booted(first, s);
    expect(readRuntime(s.home).keyListener).toBe(true);
    const second = await launch(s);
    expect(await second.exited).toBe(0);
    expect(second.out()).toMatch(/press p/i);
    await first.stop();
  });
});
