import { EventEmitter } from "node:events";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Io, openerCommand, run } from "../src/main.ts";
import { freePort, tempDir } from "./helpers.ts";

// M7.19 (#400): the opener must reach the engine over http, not through a file:// redirect page.
//
// Diagnosis (from code reading; the real Mac cannot be probed from here): `start` opened
// <home>/run/<random>.html and relied on its script doing location.replace("http://...#pair=").
// A file:// page handing off to http is the weak hop: macOS `open` routes a .html file to the
// app registered for HTML (not always the default browser), Chrome may reuse a tab or block the
// cross-scheme replace, and the owner saw GET / with no POST /v1/pairing. Opening the http URL
// directly removes the hop: `open http://127.0.0.1:<port>/#pair=<code>` goes to the default
// browser, which keeps the fragment (the owner's direct open paired fine).
//
// Intended design: the opener (io.openUrl) receives `http://127.0.0.1:<port>/#pair=<code>`
// itself. No redirect page is written under <home>/run/. Tradeoff to record in the report: the
// one-time code (10 minute TTL, loopback only, single use) is now on the opener's argv, which
// M7.08 had avoided; the lead accepts that or opens a decision ticket. (An engine-side one-time
// launch path would avoid it but is outside this ticket's Owns.)
//
// The link also carries `&keys=1` when the engine listens for the p key (a terminal stdin) so
// the web app can tell the owner when pressing p applies (see the web tests).

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function terminalStdin() {
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

async function start(io: Partial<Io>) {
  const home = tempDir();
  const web = tempDir("taskville-web-");
  writeFileSync(join(web.path, "index.html"), "<!doctype html><title>Taskville</title>");
  const controller = new AbortController();
  let out = "";
  const opened: string[] = [];
  const port = await freePort();
  const exited = run(["start", "--home", home.path, "--port", String(port)], {
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
    env: { TASKVILLE_WEB_DIR: web.path },
    cwd: home.path,
    signal: controller.signal,
    now: () => new Date("2026-11-04T12:00:00Z"),
    sourceCheckout: false,
    stdoutIsTTY: true,
    ...io,
    openUrl: async (url: string) => {
      opened.push(url);
      await io.openUrl?.(url);
    },
  } as Io);
  cleanups.push(async () => {
    controller.abort();
    await exited.catch(() => {});
    home.remove();
    web.remove();
  });
  const deadline = Date.now() + 15_000;
  while (opened.length === 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the opener");
    await new Promise((r) => setTimeout(r, 25));
  }
  return {
    home: home.path,
    port,
    opened,
    out: () => out,
    stop: () => (controller.abort(), exited),
  };
}

describe("start hands the opener the http link (M7.19)", () => {
  it("opens http://127.0.0.1:<port>/#pair=<code> directly, with no redirect page", async () => {
    const s = await start({});
    expect(s.opened).toHaveLength(1);
    expect(s.opened[0]).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/#pair=[A-Za-z0-9_-]{20,}`),
    );
    expect(s.opened[0]).not.toMatch(/^file:/);
    const runDir = join(s.home, "run");
    expect(
      existsSync(runDir) ? readdirSync(runDir).filter((n) => n.endsWith(".html")) : [],
    ).toEqual([]);
    expect(await s.stop()).toBe(0);
  });

  it("falls back to printing the same link when the opener fails", async () => {
    const calls: string[] = [];
    const s = await start({
      openUrl: async (url: string) => {
        calls.push(url);
        throw new Error("no browser");
      },
    });
    const attempted = calls[0] as string;
    await new Promise((r) => setTimeout(r, 200));
    expect(attempted).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#pair=/);
    expect(s.out()).toContain(attempted);
    await s.stop();
  });

  it("marks the link keys=1 only when a key listener runs", async () => {
    const withKeys = await start({ stdin: terminalStdin() });
    expect(withKeys.opened[0]).toMatch(/#pair=[A-Za-z0-9_-]+&keys=1$/);
    await withKeys.stop();
    const without = await start({});
    expect(without.opened[0]).toMatch(/#pair=[A-Za-z0-9_-]+$/);
    expect(without.opened[0]).not.toContain("keys=");
    await without.stop();
  });

  it("prints the keys=1 link on a terminal and no keys flag without one", async () => {
    const s = await start({ stdin: terminalStdin() });
    expect(s.out()).toMatch(/#pair=[A-Za-z0-9_-]+&keys=1/);
    await s.stop();
  });

  it("opens with the platform opener and the URL unchanged on macOS", () => {
    const url = "http://127.0.0.1:4455/#pair=abc_DEF-123&keys=1";
    expect(openerCommand("darwin", url)).toEqual({ command: "open", args: [url] });
  });
});
