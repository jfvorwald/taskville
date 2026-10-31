import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeServe } from "../../src/commands/serve.ts";
import { type Io, run } from "../../src/main.ts";
import { cli, freePort, tempDir } from "../helpers.ts";

// M2.12 (#173): a fresh pairing link from a running serve, on decision #174's default (a
// keypress in the serve terminal, printed only there), and persisted pairings (#113 default).

/** A stand-in for `process.stdin` on a terminal: raw mode, data events, resume and pause. */
class FakeTerminal extends EventEmitter {
  isTTY: boolean;
  rawModes: boolean[] = [];
  flowing = false;
  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
  }
  setRawMode(raw: boolean): this {
    this.rawModes.push(raw);
    return this;
  }
  resume(): this {
    this.flowing = true;
    return this;
  }
  pause(): this {
    this.flowing = false;
    return this;
  }
  type(keys: string): void {
    this.emit("data", Buffer.from(keys, "utf8"));
  }
}

const LINK = /(http:\/\/127\.0\.0\.1:\d+)\/#pair=([A-Za-z0-9_-]+)/g;
const T0 = Date.parse("2026-10-31T12:00:00Z");

interface Running {
  url: string;
  out: () => string;
  err: () => string;
  codes: () => string[];
  stop: () => Promise<number>;
  exited: Promise<number>;
}

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function startServe(
  home: string,
  options: { stdin?: Io["stdin"]; clock?: { ms: number } } = {},
): Promise<Running> {
  const port = await freePort();
  const controller = new AbortController();
  const clock = options.clock ?? { ms: T0 };
  let out = "";
  let err = "";
  let ready: () => void = () => {};
  const listening = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const exited = run(["serve", "--headless", "--home", home, "--port", String(port)], {
    stdout: (s) => {
      out += s;
      if (out.includes("#pair=")) ready();
    },
    stderr: (s) => {
      err += s;
    },
    env: {},
    cwd: home,
    signal: controller.signal,
    now: () => new Date(clock.ms),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  await Promise.race([
    listening,
    exited.then((code) => Promise.reject(new Error(`serve exited ${code}: ${err}`))),
  ]);
  const r: Running = {
    url: `http://127.0.0.1:${port}`,
    out: () => out,
    err: () => err,
    codes: () => [...out.matchAll(LINK)].map((m) => m[2] ?? ""),
    stop: async () => {
      controller.abort();
      return exited;
    },
    exited,
  };
  running.push(r);
  return r;
}

function exchange(serve: Running, code: string) {
  return fetch(`${serve.url}/v1/pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: serve.url },
    body: JSON.stringify({ code }),
  });
}

async function pair(serve: Running, code: string): Promise<string> {
  const res = await exchange(serve, code);
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: string }).session;
}

function asSession(serve: Running, session: string) {
  return fetch(`${serve.url}/v1/projects`, { headers: { "X-Taskville-Session": session } });
}

describe("fresh pairing link on a keypress (TTY)", () => {
  it("tells the operator about the key, and prints a new 10-minute link on p that exchanges once", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const serve = await startServe(home.path, { stdin: tty });
      expect(serve.out()).toMatch(/Press p for a new pairing link/);
      expect(tty.rawModes).toEqual([true]);
      expect(tty.flowing).toBe(true);
      tty.type("p");
      const [, fresh] = serve.codes();
      expect(fresh).toBeDefined();
      expect(serve.out().trimEnd().split("\n").at(-1)).toMatch(
        /one-time link, valid for 10 minutes\): http:\/\/127\.0\.0\.1:\d+\/#pair=/,
      );
      expect((await exchange(serve, fresh ?? "")).status).toBe(200);
      expect((await exchange(serve, fresh ?? "")).status).toBe(401);
      // The code appears only on the serve terminal's output, never in the log.
      expect(serve.err()).not.toContain(fresh);
    } finally {
      home.remove();
    }
  });

  it("keeps the previous unexpired code working after a new one is printed", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const serve = await startServe(home.path, { stdin: tty });
      tty.type("p");
      const [first, second] = serve.codes();
      expect((await exchange(serve, first ?? "")).status).toBe(200);
      expect((await exchange(serve, second ?? "")).status).toBe(200);
    } finally {
      home.remove();
    }
  });

  it("mints at most one code per second, however many keys arrive", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const clock = { ms: T0 };
      const serve = await startServe(home.path, { stdin: tty, clock });
      tty.type("pppppppppp");
      tty.type("p");
      expect(serve.codes()).toHaveLength(2);
      clock.ms += 999;
      tty.type("p");
      expect(serve.codes()).toHaveLength(2);
      clock.ms += 1;
      tty.type("P");
      expect(serve.codes()).toHaveLength(3);
    } finally {
      home.remove();
    }
  });

  it("caps outstanding codes: past the cap the oldest stops working", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const clock = { ms: T0 };
      const serve = await startServe(home.path, { stdin: tty, clock });
      for (let i = 0; i < 5; i++) {
        clock.ms += 1000;
        tty.type("p");
      }
      const codes = serve.codes();
      expect(codes).toHaveLength(6);
      expect((await exchange(serve, codes[0] ?? "")).status).toBe(401);
      expect((await exchange(serve, codes[5] ?? "")).status).toBe(200);
      expect((await exchange(serve, codes[1] ?? "")).status).toBe(200);
    } finally {
      home.remove();
    }
  });

  it("ignores other keys", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const serve = await startServe(home.path, { stdin: tty });
      tty.type("x\r\n q");
      expect(serve.codes()).toHaveLength(1);
    } finally {
      home.remove();
    }
  });

  it("stops on Ctrl-C (raw mode turns it into a byte) and restores the terminal", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const serve = await startServe(home.path, { stdin: tty });
      tty.type("\u0003");
      expect(await serve.exited).toBe(0);
      expect(serve.out()).toContain("Taskville engine stopped");
      expect(tty.rawModes).toEqual([true, false]);
      expect(tty.flowing).toBe(false);
      expect(tty.listenerCount("data")).toBe(0);
    } finally {
      home.remove();
    }
  });

  it("restores the terminal when stopped by a signal", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const serve = await startServe(home.path, { stdin: tty });
      expect(await serve.stop()).toBe(0);
      expect(tty.rawModes).toEqual([true, false]);
      expect(tty.listenerCount("data")).toBe(0);
    } finally {
      home.remove();
    }
  });
});

describe("without a terminal", () => {
  for (const [label, stdin] of [
    ["no stdin", undefined],
    ["stdin that is not a TTY", new FakeTerminal(false)],
  ] as const) {
    it(`keeps today's single link and says to restart for a new one (${label})`, async () => {
      const home = tempDir();
      try {
        const serve = await startServe(home.path, stdin === undefined ? {} : { stdin });
        expect(serve.out()).toMatch(/valid for 10 minutes/);
        expect(serve.out()).toMatch(/restart taskville serve/i);
        expect(serve.out()).not.toMatch(/Press p/);
        if (stdin !== undefined) {
          stdin.type("p");
          expect(stdin.rawModes).toEqual([]);
          expect(stdin.listenerCount("data")).toBe(0);
        }
        expect(serve.codes()).toHaveLength(1);
      } finally {
        home.remove();
      }
    });
  }
});

describe("no route mints a pairing code (#113, #174)", () => {
  it("serve's route table has only the pairing exchange and revoke, and nothing new", async () => {
    const home = tempDir();
    try {
      const parts = composeServe(
        { stdout: () => {}, stderr: () => {}, env: {}, cwd: home.path },
        home.path,
        await freePort(),
      );
      try {
        const routes = [
          ...new Set(
            parts.app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`),
          ),
        ].sort();
        expect(routes.filter((r) => /pair/i.test(r))).toEqual([
          "POST /v1/pairing",
          "POST /v1/pairing/revoke",
        ]);
        // The whole table, so a new route (an IPC or code-minting path included) is a
        // deliberate change to this test. Neither pairing route issues a code.
        expect(routes).toEqual([
          "GET /health",
          "GET /v1/commands/:id",
          "GET /v1/projects",
          "GET /v1/projects/:id/events",
          "GET /v1/projects/:id/snapshot",
          "POST /v1/commands",
          "POST /v1/events/batch",
          "POST /v1/pairing",
          "POST /v1/pairing/revoke",
          "POST /v1/projects",
          "POST /v1/sources/claude-code/hooks",
        ]);
      } finally {
        await parts.close();
      }
    } finally {
      home.remove();
    }
  });
});

describe("persisted pairings (#113 default)", () => {
  it("a paired browser survives a restart; only digests are stored; unpair revokes it for good", async () => {
    const home = tempDir();
    try {
      const tty = new FakeTerminal();
      const first = await startServe(home.path, { stdin: tty });
      tty.type("p");
      const [code, unused] = first.codes();
      const session = await pair(first, code ?? "");
      expect((await asSession(first, session)).status).toBe(200);
      expect(await first.stop()).toBe(0);

      const db = ["taskville.db", "taskville.db-wal"]
        .map((f) => join(home.path, f))
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f).toString("latin1"))
        .join("");
      expect(db).not.toContain(session);

      const second = await startServe(home.path);
      expect((await asSession(second, session)).status).toBe(200);
      // Codes are never persisted: the first run's codes, used or not, are gone.
      expect((await exchange(second, code ?? "")).status).toBe(401);
      expect(unused).toBeDefined();
      expect((await exchange(second, unused ?? "")).status).toBe(401);

      const unpaired = await cli(["unpair", "--home", home.path, "--url", second.url]);
      expect(unpaired.code).toBe(0);
      expect(unpaired.stdout).toContain("Revoked 1 browser session");
      expect((await asSession(second, session)).status).toBe(401);
      expect(await second.stop()).toBe(0);

      const third = await startServe(home.path);
      expect((await asSession(third, session)).status).toBe(401);
    } finally {
      home.remove();
    }
  });
});
