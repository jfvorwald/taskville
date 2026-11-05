import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock } from "../src/commands/serve.ts";
import { tempDir } from "./helpers.ts";

// M7.08 (#380) roborev re-review findings, red phase. Seams:
//   serve.ts exports acquireLock(home, deps?): Promise<() => void>, with optional deps
//       { pidAlive?: (pid: number) => boolean; waitMs?: number } (defaults: the real check and
//       the current LOCK_WAIT_MS). Rejects with a CliError when it cannot take the lock.
//   Stale takeover must be atomic: rename the stale lock aside to a unique name (only one rename
//       succeeds), confirm what was moved is the stale one, then O_EXCL create. A taker that
//       lost must never unlink or replace a lock another process just created.
//   A lock path that is not a regular file (directory, etc.) is a prompt failure with one
//       sentence naming the path; no retry loop. Every retry path awaits (yields) between tries.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function home(): string {
  const h = tempDir();
  cleanups.push(h.remove);
  return h.path;
}

const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid as number;

describe("stale-lock takeover is atomic", () => {
  it("lets exactly one of two takers of the same dead lock acquire", async () => {
    const h = home();
    const dead = deadPid();
    writeFileSync(join(h, "engine.lock"), `${dead}\n`);
    // Real pids are used for the live check, except the dead one.
    const alive = (pid: number) => pid !== dead;
    let taker1: Promise<() => void> | undefined;
    let fired = false;
    // Taker 2 has just judged the lock stale (its pidAlive call returned false). Before it can
    // act, taker 1 sees the same dead lock and runs its whole takeover.
    const taker2 = acquireLock(h, {
      waitMs: 300,
      pidAlive: (pid) => {
        const result = alive(pid);
        if (!fired && !result) {
          fired = true;
          taker1 = acquireLock(h, { waitMs: 300, pidAlive: alive });
        }
        return result;
      },
    });
    const results = await Promise.allSettled([
      taker1 ?? Promise.reject(new Error("no taker1")),
      taker2,
    ]);
    const acquired = results.filter((r) => r.status === "fulfilled").length;
    expect(acquired).toBe(1);
    for (const r of results) if (r.status === "fulfilled") r.value();
  });
});

describe("a non-regular file at engine.lock", () => {
  // Run in a child process so the current infinite synchronous loop cannot hang the runner.
  function inChild(h: string, timeoutMs: number) {
    const script = `
      import { acquireLock } from ${JSON.stringify(join(import.meta.dirname, "../src/commands/serve.ts"))};
      let last = Date.now(); let maxGap = 0;
      setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10).unref();
      const t0 = Date.now();
      let message = "";
      try { await acquireLock(${JSON.stringify(h)}, { waitMs: 300 }); message = "ACQUIRED"; }
      catch (e) { message = String(e && e.message); }
      console.log(JSON.stringify({ message, elapsed: Date.now() - t0, maxGap }));
      process.exit(0);
    `;
    return new Promise<{ timedOut: boolean; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ timedOut: true, out });
      }, timeoutMs);
      child.on("close", () => {
        clearTimeout(timer);
        resolve({ timedOut: false, out });
      });
    });
  }

  it("fails promptly with one sentence naming the path, instead of looping", async () => {
    const h = home();
    const path = join(h, "engine.lock");
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "x");
    const r = await inChild(h, 2500);
    expect(r.timedOut, "acquireLock never returned (busy loop)").toBe(false);
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.message).toContain(path);
    expect(parsed.message).not.toBe("ACQUIRED");
    expect(parsed.message.trim().split("\n")).toHaveLength(1);
    expect(parsed.elapsed).toBeLessThan(1000);
  });

  it("never blocks the event loop between attempts", async () => {
    const h = home();
    mkdirSync(join(h, "engine.lock"));
    const r = await inChild(h, 2500);
    expect(r.timedOut, "event loop starved by a synchronous retry loop").toBe(false);
    expect(JSON.parse(r.out.trim()).maxGap).toBeLessThan(200);
  });
});

// roborev job 7034: an unreadable lock file must fail fast, and stale-lock reclamation must be
// serialized by a reclaim mutex (engine.lock.reclaim) so no taker ever moves a live lock.
describe("roborev 7034", () => {
  it.skipIf(process.getuid?.() === 0)(
    "an unreadable lock file fails promptly with one sentence naming the path",
    async () => {
      const h = home();
      const path = join(h, "engine.lock");
      writeFileSync(path, "123\n");
      chmodSync(path, 0o000);
      cleanups.push(() => chmodSync(path, 0o600));
      const started = Date.now();
      await expect(acquireLock(h, { waitMs: 300 })).rejects.toThrow(path);
      expect(Date.now() - started).toBeLessThan(250);
    },
  );

  it("a reclaim mutex left behind by a crashed taker does not block a stale takeover", async () => {
    const h = home();
    const dead = deadPid();
    writeFileSync(join(h, "engine.lock"), `${dead}\n`);
    const reclaim = join(h, "engine.lock.reclaim");
    writeFileSync(reclaim, `${dead}\n`);
    const release = await acquireLock(h, { waitMs: 2000, pidAlive: (pid) => pid !== dead });
    expect(readFileSync(join(h, "engine.lock"), "utf8").trim()).toBe(`${process.pid}`);
    expect(existsSync(reclaim)).toBe(false);
    release();
  });

  it("a live taker's lock is never moved aside: no stale files appear while it is held", async () => {
    const h = home();
    const dead = deadPid();
    writeFileSync(join(h, "engine.lock"), `${dead}\n`);
    const alive = (pid: number) => pid !== dead;
    let first: (() => void) | undefined;
    let fired = false;
    const second = acquireLock(h, {
      waitMs: 200,
      pidAlive: (pid) => {
        const result = alive(pid);
        if (!fired && !result) {
          fired = true;
          // The other taker completes its takeover before this one acts on its stale judgment.
          void acquireLock(h, { waitMs: 200, pidAlive: alive }).then((r) => {
            first = r;
          });
        }
        return result;
      },
    });
    await expect(second).rejects.toThrow();
    expect(first).toBeDefined();
    expect(readdirSync(h).filter((n) => n.includes(".stale."))).toEqual([]);
    expect(readFileSync(join(h, "engine.lock"), "utf8").trim()).toBe(`${process.pid}`);
    first?.();
  });
});
