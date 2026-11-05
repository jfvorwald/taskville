import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Io, run, spawnOpener } from "../src/main.ts";
import { freePort, tempDir } from "./helpers.ts";

// M7.08 (#380) roborev findings, red phase. Seams:
//   <home>/engine.lock: exclusive (O_EXCL) startup lock holding the pid as decimal text, taken
//       before the live-engine check, released after engine.json is written (or on failure), and
//       removed on shutdown. A lock whose pid is dead is taken over.
//   main.ts exports spawnOpener(command, args, spawnFn = spawn): Promise<void>. It resolves only
//       after the child exits 0 and rejects on a nonzero exit or a spawn error.
//   A second concurrent start reports "already running at <url>" and exits 0.

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
const lockFile = (home: string) => join(home, "engine.lock");

interface Run {
  out: () => string;
  err: () => string;
  exited: Promise<number>;
  port: number;
  stop: () => Promise<number>;
}

async function launch(
  argv: string[],
  s: ReturnType<typeof setup>,
  io: Partial<Io> = {},
  givenPort?: number,
): Promise<Run> {
  const port = givenPort ?? (await freePort());
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
  return {
    out: () => out,
    err: () => err,
    exited,
    port,
    stop: async () => {
      controller.abort();
      return exited;
    },
  };
}

const COMMANDS: Array<[string, string[]]> = [
  ["start", ["start", "--no-open"]],
  ["serve", ["serve", "--headless"]],
];

describe("engine.json that is not an object", () => {
  for (const [label, argv] of COMMANDS) {
    for (const content of ["null", "[]", '"x"', "42"]) {
      it(`${label} treats ${content} as no running engine and replaces it`, async () => {
        const s = setup();
        writeFileSync(engineJson(s.home), `${content}\n`);
        const r = await launch(argv, s);
        let exitedEarly: number | undefined;
        void r.exited.then((code) => {
          exitedEarly = code;
        });
        await until(() => {
          if (exitedEarly !== undefined) {
            throw new Error(
              `exited ${exitedEarly} before replacing engine.json: ${r.err().trim()}`,
            );
          }
          try {
            return JSON.parse(readFileSync(engineJson(s.home), "utf8"))?.url !== undefined;
          } catch {
            return false;
          }
        }, "replaced engine.json");
        expect(r.err()).not.toMatch(/TypeError|Cannot read/);
        expect(JSON.parse(readFileSync(engineJson(s.home), "utf8")).url).toBe(
          `http://127.0.0.1:${r.port}`,
        );
        expect(await r.stop()).toBe(0);
      });
    }
  }
});

describe("the per-home startup lock", () => {
  it("lets exactly one of two concurrent starts bind; the other reports it and exits 0", async () => {
    const s = setup();
    const [portA, portB] = [await freePort(), await freePort()];
    // Both calls begin in the same tick, before either can have written engine.json.
    const [a, b] = await Promise.all([
      launch(["start", "--no-open"], s, {}, portA),
      launch(["start", "--no-open"], s, {}, portB),
    ]);
    const first = await Promise.race([
      a.exited.then((code) => ({ who: "a", code })),
      b.exited.then((code) => ({ who: "b", code })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("neither start exited: both engines bound")), 3000),
      ),
    ]);
    expect(first.code).toBe(0);
    const loser = first.who === "a" ? a : b;
    const winner = first.who === "a" ? b : a;
    expect(first.code).toBe(0);
    await until(() => existsSync(engineJson(s.home)), "engine.json");
    const info = JSON.parse(readFileSync(engineJson(s.home), "utf8"));
    expect(info.url).toBe(`http://127.0.0.1:${winner.port}`);
    expect(loser.out()).toContain(`already running at ${info.url}`);
    expect(loser.out()).not.toContain("engine listening");
    expect((await fetch(`${info.url}/health`)).status).toBeLessThan(500);
    await expect(fetch(`http://127.0.0.1:${loser.port}/health`)).rejects.toThrow();
    expect(await winner.stop()).toBe(0);
  });

  it("removes engine.lock on a clean shutdown", async () => {
    const s = setup();
    const r = await launch(["start", "--no-open"], s);
    await until(() => existsSync(engineJson(s.home)), "engine.json");
    expect(await r.stop()).toBe(0);
    expect(existsSync(lockFile(s.home))).toBe(false);
  });

  it("takes over a stale lock whose pid is dead", async () => {
    const s = setup();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    writeFileSync(lockFile(s.home), `${dead}\n`);
    const r = await launch(["start", "--no-open"], s);
    await until(() => existsSync(engineJson(s.home)), "engine.json");
    expect(JSON.parse(readFileSync(engineJson(s.home), "utf8")).url).toBe(
      `http://127.0.0.1:${r.port}`,
    );
    expect(await r.stop()).toBe(0);
  });
});

describe("start usage", () => {
  it("prints the start usage, not the serve usage, for a bad --port", async () => {
    const s = setup();
    let err = "";
    const code = await run(["start", "--port", "abc", "--home", s.home], {
      stdout: () => {},
      stderr: (t) => {
        err += t;
      },
      env: s.env,
      cwd: s.home,
    });
    expect(code).not.toBe(0);
    expect(err).toContain("taskville start [--port N]");
    expect(err).not.toContain("serve --headless");
  });
});

describe("spawnOpener", () => {
  function fakeSpawn(finish: (child: EventEmitter) => void) {
    return ((_command: string, _args: string[]) => {
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => {
        child.emit("spawn");
        finish(child);
      });
      return child;
    }) as unknown as Parameters<typeof spawnOpener>[2];
  }

  it("resolves only after the opener exits 0", async () => {
    let exit: (() => void) | undefined;
    let settled = false;
    const done = spawnOpener(
      "open",
      ["x"],
      fakeSpawn((child) => {
        exit = () => child.emit("close", 0, null);
      }),
    ).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    exit?.();
    await done;
    expect(settled).toBe(true);
  });

  it("rejects on a nonzero exit so the link fallback runs", async () => {
    await expect(
      spawnOpener(
        "open",
        ["x"],
        fakeSpawn((child) => child.emit("close", 1, null)),
      ),
    ).rejects.toThrow();
  });

  it("rejects when the opener cannot start", async () => {
    await expect(
      spawnOpener(
        "open",
        ["x"],
        fakeSpawn((child) => child.emit("error", new Error("ENOENT"))),
      ),
    ).rejects.toThrow("ENOENT");
  });
});
