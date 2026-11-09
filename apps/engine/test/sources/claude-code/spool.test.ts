// M2.07: spool ingest on engine start (ARCHITECTURE.md 8.1). The spool format
// is the one the shim writes (apps/cli/hooks/claude-code-shim.sh header).

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { mapClaudeCodeHook } from "@taskville/adapters/claude-code";
import type { ProjectState } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IngestPipeline } from "../../../src/ingest/index.ts";
import {
  CLAUDE_CODE_HOOKS_PATH,
  ClaudeCodeSource,
  drainSpool,
  type HookInput,
  registerClaudeCodeRoutes,
  replaySpool,
  SPOOL_FILE,
  type SpoolReplayReport,
} from "../../../src/sources/claude-code/index.ts";
import { bearer, CLI_TOKEN, makeApp, postJson } from "../../http/helpers.ts";
import { fixedNow, makeSource, T0, useProjects } from "./helpers.ts";

/**
 * Seams in node:fs for the lock races of M7.32, pass-through unless a test sets them.
 * `afterMkdir` runs right after a mkdirSync succeeds: there a shim whose mkdir(1) is not
 * atomic (uutils coreutils 0.8.0, Ubuntu 26.04) can report success for the same directory
 * and create its pid file first. `lockPidGone` runs right after the engine's lock pid file
 * is removed and before the directory is.
 */
const seam = vi.hoisted(() => ({
  afterMkdir: undefined as ((path: string) => void) | undefined,
  lockPidGone: undefined as ((lock: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const path = await import("node:path");
  const LOCK_DIR = "claude-code.lock";
  return {
    ...real,
    mkdirSync: ((...args: Parameters<typeof real.mkdirSync>) => {
      const made = real.mkdirSync(...args);
      seam.afterMkdir?.(String(args[0]));
      return made;
    }) as typeof real.mkdirSync,
    unlinkSync: (target: Parameters<typeof real.unlinkSync>[0]) => {
      real.unlinkSync(target);
      const dir = path.dirname(String(target));
      if (path.basename(String(target)) === "pid" && path.basename(dir) === LOCK_DIR) {
        seam.lockPidGone?.(dir);
      }
    },
    // A recursive rm removes the entries and then the directory; the gap between is modelled.
    rmSync: (
      target: Parameters<typeof real.rmSync>[0],
      options?: Parameters<typeof real.rmSync>[1],
    ) => {
      const pid = path.join(String(target), "pid");
      if (seam.lockPidGone && path.basename(String(target)) === LOCK_DIR && real.existsSync(pid)) {
        real.unlinkSync(pid);
        seam.lockPidGone(String(target));
      }
      real.rmSync(target, options);
    },
  };
});

const SHIM = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "cli",
  "hooks",
  "claude-code-shim.sh",
);

const db = useProjects([{ id: "repo", roots: ["/work/repo"] }]);

let spoolDir = "";
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "taskville-spool-"));
  spoolDir = join(root, "spool");
  mkdirSync(spoolDir, { mode: 0o700 });
});
afterEach(() => {
  seam.afterMkdir = undefined;
  seam.lockPidGone = undefined;
  rmSync(root, { recursive: true, force: true });
});

const SPOOLED_AT = "2026-10-31T09:15:00Z";

let counter = 0;
function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function hook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-1",
    cwd: "/work/repo",
    hook_event_name: "UserPromptSubmit",
    prompt: "do the thing",
    ...overrides,
  };
}

interface Line {
  payload: Record<string, unknown> | null;
  sourceEventId: string;
  spooledAt: string;
  payloadBytesAtLeast?: number;
}

/** A spool line exactly as the shim writes it: payload first, then the shim's keys. */
function line(l: Partial<Line> = {}): string {
  const full: Line = { payload: hook(), sourceEventId: uuid(), spooledAt: SPOOLED_AT, ...l };
  const extra =
    full.payloadBytesAtLeast === undefined
      ? ""
      : `,"payloadBytesAtLeast":${full.payloadBytesAtLeast}`;
  return `{"payload":${JSON.stringify(full.payload)}${extra},"sourceEventId":"${full.sourceEventId}","spooledAt":"${full.spooledAt}"}\n`;
}

const main = () => join(spoolDir, SPOOL_FILE);

/** A capturing pino logger, so tests can check that no spool content is ever logged. */
function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  return { logger: pino({ level: "debug" }, stream), text: () => lines.join("") };
}

/** The real M2.03 mapper and M1 pipeline over the test database. */
function realSource(now = () => new Date(Date.parse("2026-10-31T12:00:00Z"))) {
  const storage = db();
  const pipeline = new IngestPipeline({ storage, now });
  return new ClaudeCodeSource({ pipeline, storage, mapper: mapClaudeCodeHook, now });
}

function repoEvents() {
  return [...db().events("repo", 0)].filter((e) => e.sourceId === "claude-code");
}

function spoolNames(): string[] {
  return readdirSync(spoolDir).sort();
}

function counts(report: SpoolReplayReport) {
  const { accepted, duplicate, conflict, rejected } = report;
  return { accepted, duplicate, conflict, rejected };
}

describe("replaySpool", () => {
  it("replays the main file late, dated at spooledAt, and removes it once committed", async () => {
    const id = uuid();
    writeFileSync(main(), line({ sourceEventId: id }), { mode: 0o600 });
    const report = await replaySpool({ spoolDir, source: realSource() });

    expect(report).toMatchObject({ mainFile: "claimed", hooks: 1, failed: false });
    expect(report.accepted).toBeGreaterThan(0);
    const events = repoEvents();
    expect(events.length).toBe(report.accepted);
    for (const event of events) {
      expect(event.late).toBe(true);
      expect(event.occurredAt).toBe(SPOOLED_AT);
      expect(event.sourceEventId.startsWith(id)).toBe(true);
    }
    expect(spoolNames()).toEqual([]);
  });

  it("never opens needs-you for a spooled permission prompt", async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../../../fixtures/claude-code/permission/notification-permission-prompt.json",
        ),
        "utf8",
      ),
    ) as { body: Record<string, unknown> };
    const payload = { ...fixture.body, cwd: "/work/repo" };
    writeFileSync(main(), line({ payload }), { mode: 0o600 });
    const report = await replaySpool({ spoolDir, source: realSource() });
    expect(report.accepted).toBeGreaterThan(0);

    const opened = repoEvents().filter((e) => e.type === "request.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.late).toBe(true);
    const state = db().projection<ProjectState>("repo")?.state;
    expect(state).toBeDefined();
    const requests = Object.values(state?.requests ?? {});
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ late: true, answerable: false });
    expect(requests[0]?.state).not.toBe("open");
    const needsYou = attention(state as ProjectState, Date.parse("2026-10-31T12:00:00Z")).filter(
      (a) => a.level === "needs_you",
    );
    expect(needsYou).toEqual([]);
  });

  it("dedupes a hook that was posted live and spooled anyway", async () => {
    const source = realSource();
    const id = uuid();
    const payload = hook({ prompt: "posted, then timed out on the shim side" });
    const live = await source.ingestHook({ sourceEventId: id, payload });
    expect(live.results.every((r) => r.status === "accepted")).toBe(true);
    const head = db().head("repo");

    writeFileSync(main(), line({ sourceEventId: id, payload }), { mode: 0o600 });
    const report = await replaySpool({ spoolDir, source });
    expect(counts(report)).toEqual({
      accepted: 0,
      duplicate: live.results.length,
      conflict: 0,
      rejected: 0,
    });
    expect(db().head("repo")).toBe(head);
    expect(repoEvents().every((e) => e.late === false)).toBe(true);
    expect(spoolNames()).toEqual([]);
  });

  it("is idempotent when the same spool is replayed twice (a crash before delete)", async () => {
    const text = line() + line() + line();
    writeFileSync(main(), text, { mode: 0o600 });
    const first = await replaySpool({ spoolDir, source: realSource() });
    const head = db().head("repo");
    writeFileSync(main(), text, { mode: 0o600 });
    const second = await replaySpool({ spoolDir, source: realSource() });
    expect(second.accepted).toBe(0);
    expect(second.duplicate).toBe(first.accepted);
    expect(db().head("repo")).toBe(head);
  });

  it("loses and duplicates nothing when ingest fails midway", async () => {
    const ids = [uuid(), uuid(), uuid(), uuid()];
    writeFileSync(main(), ids.map((sourceEventId) => line({ sourceEventId })).join(""), {
      mode: 0o600,
    });
    const real = realSource();
    let calls = 0;
    const flaky = {
      ingestHook(input: HookInput) {
        calls += 1;
        if (calls === 3) return Promise.reject(new Error("disk I/O error: secret tool output"));
        return real.ingestHook(input);
      },
    };
    const log = captureLogger();
    const failed = await replaySpool({ spoolDir, source: flaky, logger: log.logger });
    expect(failed.failed).toBe(true);
    expect(log.text()).not.toContain("secret tool output");
    // The claimed file is kept for the next start.
    expect(spoolNames().filter((n) => n.endsWith(".jsonl"))).toHaveLength(1);

    const again = await replaySpool({ spoolDir, source: realSource() });
    expect(again.failed).toBe(false);
    const byHook = new Map<string, number>();
    for (const e of repoEvents()) {
      const hookId = e.sourceEventId.slice(0, 36);
      byHook.set(hookId, (byHook.get(hookId) ?? 0) + 1);
    }
    expect([...byHook.keys()].sort()).toEqual([...ids].sort());
    // Each hook's events are in the log exactly once.
    const perHook = new Set(byHook.values());
    expect(perHook.size).toBe(1);
    expect(again.duplicate).toBe(2 * ([...perHook][0] ?? 0));
    expect(spoolNames()).toEqual([]);
  });

  it("keeps a line the shim appends during replay", async () => {
    writeFileSync(main(), line() + line(), { mode: 0o600 });
    const real = realSource();
    const lateId = uuid();
    let appended = false;
    const appending = {
      ingestHook(input: HookInput) {
        if (!appended) {
          appended = true;
          // What a shim does while the engine replays: append to a fresh main file.
          appendFileSync(main(), line({ sourceEventId: lateId }), { mode: 0o600 });
        }
        return real.ingestHook(input);
      },
    };
    const first = await replaySpool({ spoolDir, source: appending });
    expect(first.hooks).toBe(2);
    expect(readFileSync(main(), "utf8")).toContain(lateId);

    const second = await replaySpool({ spoolDir, source: real });
    expect(second.hooks).toBe(1);
    expect(repoEvents().some((e) => e.sourceEventId.startsWith(lateId))).toBe(true);
    expect(spoolNames()).toEqual([]);
  });

  it("replays per-event files, ignores dot temporaries, and orders by spooledAt", async () => {
    const early = uuid();
    const middle = uuid();
    const lateId = uuid();
    writeFileSync(main(), line({ sourceEventId: lateId, spooledAt: "2026-10-31T09:20:00Z" }), {
      mode: 0o600,
    });
    writeFileSync(
      join(spoolDir, `claude-code.${middle}.jsonl`),
      line({ sourceEventId: middle, spooledAt: "2026-10-31T09:10:00Z" }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(spoolDir, `claude-code.${early}.jsonl`),
      line({ sourceEventId: early, spooledAt: "2026-10-31T09:00:00+00:00" }),
      { mode: 0o600 },
    );
    const temp = join(spoolDir, ".claude-code.Ab12Cd");
    mkdirSync(temp, { mode: 0o700 });
    writeFileSync(join(temp, "line"), line());

    const { source, mapper } = makeSource(db());
    const report = await replaySpool({ spoolDir, source });
    expect(report.hooks).toBe(3);
    expect(mapper.calls.map((c) => c.sourceEventId)).toEqual([early, middle, lateId]);
    expect(mapper.calls.map((c) => c.late)).toEqual([true, true, true]);
    expect(mapper.calls.map((c) => c.receivedAt)).toEqual([
      "2026-10-31T09:00:00+00:00",
      "2026-10-31T09:10:00Z",
      "2026-10-31T09:20:00Z",
    ]);
    // A fresh temporary may belong to a running shim: left alone.
    expect(spoolNames()).toEqual([".claude-code.Ab12Cd"]);
  });

  it("removes shim temporaries older than a minute", async () => {
    const temp = join(spoolDir, ".claude-code.Old123");
    mkdirSync(temp, { mode: 0o700 });
    writeFileSync(join(temp, "payload"), "{}");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(temp, old, old);
    await replaySpool({ spoolDir, source: makeSource(db()).source });
    expect(existsSync(temp)).toBe(false);
  });

  it("counts unparseable and malformed lines and never logs their content", async () => {
    const good = uuid();
    const bad = [
      '{"payload":{"torn": "SECRET-1',
      "not json SECRET-2",
      JSON.stringify({
        payload: hook(),
        sourceEventId: uuid(),
        spooledAt: SPOOLED_AT,
        extra: "SECRET-3",
      }),
      JSON.stringify({ payload: [], sourceEventId: uuid(), spooledAt: SPOOLED_AT }),
      JSON.stringify({ payload: hook(), sourceEventId: "x".repeat(171), spooledAt: SPOOLED_AT }),
      // Only the shim's lowercase UUID v4 (roborev 5161): a secret-shaped ID is never replayed.
      JSON.stringify({
        payload: hook(),
        sourceEventId: "ghp_SECRET0123456789abcdefghijklmnopqrstu",
        spooledAt: SPOOLED_AT,
      }),
      JSON.stringify({
        payload: hook(),
        sourceEventId: "3F2B8C1E-9A4D-4E7F-B6A1-0C5D2E8F7A93",
        spooledAt: SPOOLED_AT,
      }),
      JSON.stringify({ payload: hook(), sourceEventId: "u-1", spooledAt: SPOOLED_AT }),
      JSON.stringify({ payload: hook(), sourceEventId: uuid(), spooledAt: "yesterday" }),
      JSON.stringify({ payload: hook(), sourceEventId: uuid() }),
      '{"payload":{},"sourceEventId":"u","spooledAt":"2026-10-31T09:15:00Z","__proto__":{"late":false}}',
      "[]",
      "",
    ];
    writeFileSync(main(), `${bad.join("\n")}\n${line({ sourceEventId: good })}`, { mode: 0o600 });
    const log = captureLogger();
    const { source, mapper } = makeSource(db());
    const report = await replaySpool({ spoolDir, source, logger: log.logger });
    expect(report.invalidLines).toBe(bad.length - 1); // the empty line is not counted
    expect(report.hooks).toBe(1);
    expect(mapper.calls.map((c) => c.sourceEventId)).toEqual([good]);
    expect(log.text()).not.toMatch(/SECRET|do the thing/);
    expect(log.text()).toContain('"invalidLines":12');
    expect(spoolNames()).toEqual([]);
  });

  it("skips and counts the oversized marker", async () => {
    writeFileSync(
      main(),
      line({ payload: null, payloadBytesAtLeast: 5_241_857 }) +
        `{"payload":null,"payloadBytesAtLeast":-1,"sourceEventId":"${uuid()}","spooledAt":"${SPOOLED_AT}"}\n` +
        line(),
      { mode: 0o600 },
    );
    const { source, mapper } = makeSource(db());
    const report = await replaySpool({ spoolDir, source });
    expect(report).toMatchObject({ oversized: 1, invalidLines: 1, hooks: 1 });
    expect(mapper.calls).toHaveLength(1);
  });

  it("bounds one run and leaves the rest, unrepeated, for the next", async () => {
    const ids = Array.from({ length: 7 }, () => uuid());
    writeFileSync(main(), ids.map((sourceEventId) => line({ sourceEventId })).join(""), {
      mode: 0o600,
    });
    const { source, mapper } = makeSource(db());

    const first = await replaySpool({ spoolDir, source, maxHooks: 3 });
    expect(first).toMatchObject({ hooks: 3, deferredFiles: 1 });
    // The partly read file is not copied: it stays put with a resume offset beside it.
    const [claimed, offset] = spoolNames();
    expect(claimed).toMatch(/^claude-code\.replay-[0-9a-f-]{36}\.jsonl$/);
    expect(offset).toBe(`${claimed}.offset`);
    const second = await replaySpool({ spoolDir, source, maxHooks: 3 });
    expect(second).toMatchObject({ hooks: 3, deferredFiles: 1 });
    expect(spoolNames()).toEqual([claimed, offset]);
    const third = await replaySpool({ spoolDir, source, maxHooks: 3 });
    expect(third).toMatchObject({ hooks: 1, deferredFiles: 0 });
    // Every hook replayed exactly once, in order, across the three runs.
    expect(mapper.calls.map((c) => c.sourceEventId)).toEqual(ids);
    expect(spoolNames()).toEqual([]);
  });

  it("drains a bounded spool in several runs, each hook once", async () => {
    const ids = Array.from({ length: 7 }, () => uuid());
    writeFileSync(main(), ids.map((sourceEventId) => line({ sourceEventId })).join(""), {
      mode: 0o600,
    });
    const { source, mapper } = makeSource(db());
    const total = await drainSpool({ spoolDir, source, maxHooks: 3, pauseMs: 1 });
    expect(total).toMatchObject({ hooks: 7, deferredFiles: 0, failed: false });
    expect(mapper.calls.map((c) => c.sourceEventId)).toEqual(ids);
    expect(spoolNames()).toEqual([]);
  });

  it("keeps draining while a live shim holds the lock, then takes the main file", async () => {
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    const lock = join(spoolDir, "claude-code.lock");
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "pid"), `${holder.pid}\n`);
      writeFileSync(main(), line(), { mode: 0o600 });
      const { source, mapper } = makeSource(db());
      const draining = drainSpool({ spoolDir, source, lockWaitMs: 20, pauseMs: 20 });
      // The shim finishes its append and lets go while the drain is waiting.
      setTimeout(() => rmSync(lock, { recursive: true, force: true }), 60);
      const total = await draining;
      expect(total).toMatchObject({ hooks: 1, mainFile: "claimed", failed: false });
      expect(mapper.calls).toHaveLength(1);
      expect(spoolNames()).toEqual([]);
    } finally {
      holder.kill();
    }
  });

  it("gives up draining after a few idle runs on a lock that is never released", async () => {
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const lock = join(spoolDir, "claude-code.lock");
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "pid"), `${holder.pid}\n`);
      writeFileSync(main(), line(), { mode: 0o600 });
      const { source } = makeSource(db());
      const total = await drainSpool({ spoolDir, source, lockWaitMs: 10, pauseMs: 1 });
      expect(total).toMatchObject({ hooks: 0, mainFile: "busy" });
      expect(existsSync(main())).toBe(true);
    } finally {
      holder.kill();
    }
  });

  it("quarantines a hook that fails 3 times across runs and replays the lines after it", async () => {
    const [a, poison, b] = [uuid(), uuid(), uuid()];
    const poisonLine = line({
      sourceEventId: poison,
      payload: hook({ prompt: "poison SECRET-P" }),
    });
    writeFileSync(main(), line({ sourceEventId: a }) + poisonLine + line({ sourceEventId: b }), {
      mode: 0o600,
    });
    const { source, mapper } = makeSource(db());
    const throwing = {
      ingestHook(input: HookInput) {
        if (input.sourceEventId === poison) {
          return Promise.reject(new TypeError("mapper choked on SECRET-P"));
        }
        return source.ingestHook(input);
      },
    };
    const log = captureLogger();
    const run = () => replaySpool({ spoolDir, source: throwing, logger: log.logger });

    for (const attempt of [1, 2]) {
      const report = await run();
      expect(report, `run ${attempt}`).toMatchObject({ failed: true, poisoned: 0 });
      expect(mapper.calls.some((c) => c.sourceEventId === b)).toBe(false);
    }
    const third = await run();
    expect(third).toMatchObject({ failed: false, poisoned: 1 });
    // The line after the poison line is replayed, once.
    expect(mapper.calls.filter((c) => c.sourceEventId === b)).toHaveLength(1);

    const poisonFile = join(spoolDir, "claude-code.poison.jsonl");
    expect(readFileSync(poisonFile, "utf8")).toBe(poisonLine);
    expect(statSync(poisonFile).mode & 0o777).toBe(0o600);
    expect(log.text()).toContain("TypeError");
    expect(log.text()).not.toContain("SECRET-P");
    // Nothing left to retry: the poison file itself is never replayed.
    const fourth = await run();
    expect(fourth).toMatchObject({ hooks: 0, failed: false, poisoned: 0 });
    expect(spoolNames()).toEqual(["claude-code.poison.jsonl"]);
  });

  it("never retries a quarantined hook when a later hook fails in the same run", async () => {
    const [p1, p2, b] = [uuid(), uuid(), uuid()];
    const lines = [
      line({ sourceEventId: p1 }),
      line({ sourceEventId: p2 }),
      line({ sourceEventId: b }),
    ];
    writeFileSync(main(), lines.join(""), { mode: 0o600 });
    const { source, mapper } = makeSource(db());
    const tries = new Map<string, number>();
    const throwing = {
      ingestHook(input: HookInput) {
        tries.set(input.sourceEventId, (tries.get(input.sourceEventId) ?? 0) + 1);
        if (input.sourceEventId === p1 || input.sourceEventId === p2) {
          return Promise.reject(new Error("always"));
        }
        return source.ingestHook(input);
      },
    };
    const reports: SpoolReplayReport[] = [];
    for (let i = 0; i < 5; i++) reports.push(await replaySpool({ spoolDir, source: throwing }));
    // p1 is quarantined on run 3 and never tried again; p2 on run 5; then b replays.
    expect(reports.map((r) => r.poisoned)).toEqual([0, 0, 1, 0, 1]);
    expect(tries.get(p1)).toBe(3);
    expect(tries.get(p2)).toBe(3);
    expect(mapper.calls.map((c) => c.sourceEventId)).toEqual([b]);
    const poisonFile = join(spoolDir, "claude-code.poison.jsonl");
    expect(readFileSync(poisonFile, "utf8")).toBe(lines.slice(0, 2).join(""));
    expect(spoolNames()).toEqual(["claude-code.poison.jsonl"]);
  });

  it("keeps a quarantined hook skipped when its spool file cannot be advanced", async () => {
    const [p, a, b] = [uuid(), uuid(), uuid()];
    const file = join(spoolDir, `claude-code.${p}.jsonl`);
    writeFileSync(
      file,
      line({ sourceEventId: p }) + line({ sourceEventId: a }) + line({ sourceEventId: b }),
      {
        mode: 0o600,
      },
    );
    // A directory where the offset file would go: every offset write fails (like ENOSPC).
    mkdirSync(`${file}.offset`);
    const { source } = makeSource(db());
    const tries = new Map<string, number>();
    const throwing = {
      ingestHook(input: HookInput) {
        tries.set(input.sourceEventId, (tries.get(input.sourceEventId) ?? 0) + 1);
        return input.sourceEventId === p
          ? Promise.reject(new Error("always"))
          : source.ingestHook(input);
      },
    };
    for (let i = 0; i < 4; i++) await replaySpool({ spoolDir, source: throwing, maxHooks: 2 });
    // Quarantined on run 3; run 4 rereads the file from the start but does not retry it.
    expect(tries.get(p)).toBe(3);
    expect(
      readFileSync(join(spoolDir, "claude-code.poison.jsonl"), "utf8").split("\n"),
    ).toHaveLength(2);
  });

  it("does not quarantine a hook that fails once and then succeeds", async () => {
    const id = uuid();
    writeFileSync(main(), line({ sourceEventId: id }), { mode: 0o600 });
    const { source, mapper } = makeSource(db());
    let calls = 0;
    const flaky = {
      ingestHook(input: HookInput) {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("busy")) : source.ingestHook(input);
      },
    };
    expect(await replaySpool({ spoolDir, source: flaky })).toMatchObject({ failed: true });
    expect(await replaySpool({ spoolDir, source: flaky })).toMatchObject({
      failed: false,
      poisoned: 0,
      hooks: 1,
    });
    expect(mapper.calls).toHaveLength(1);
    // The attempt count is cleared on success, so nothing is left behind.
    expect(spoolNames()).toEqual([]);
  });

  it("stops draining on a failed run", async () => {
    writeFileSync(main(), line() + line() + line(), { mode: 0o600 });
    const failing = { ingestHook: () => Promise.reject(new Error("boom")) };
    const total = await drainSpool({ spoolDir, source: failing, maxHooks: 1, pauseMs: 1 });
    expect(total).toMatchObject({ hooks: 0, failed: true });
    expect(spoolNames().filter((n) => n.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("removes an offset whose spool file is gone", async () => {
    const orphan = join(spoolDir, `claude-code.replay-${uuid()}.jsonl.offset`);
    writeFileSync(orphan, "123\n", { mode: 0o600 });
    await replaySpool({ spoolDir, source: makeSource(db()).source });
    expect(existsSync(orphan)).toBe(false);
  });

  it("bounds one run by bytes too", async () => {
    const big = hook({ prompt: "p".repeat(4000) });
    writeFileSync(
      main(),
      line({ payload: big }) + line({ payload: big }) + line({ payload: big }),
      {
        mode: 0o600,
      },
    );
    const { source, mapper } = makeSource(db());
    const first = await replaySpool({ spoolDir, source, maxBytes: 6000 });
    expect(first.hooks).toBe(1);
    await replaySpool({ spoolDir, source, maxBytes: 6000 });
    await replaySpool({ spoolDir, source, maxBytes: 6000 });
    expect(mapper.calls).toHaveLength(3);
    expect(spoolNames()).toEqual([]);
  });

  it("skips a line longer than the shim can write without reading it into memory whole", async () => {
    const huge = `{"payload":{"x":"${"y".repeat(6 * 1024 * 1024)}"},"sourceEventId":"${uuid()}","spooledAt":"${SPOOLED_AT}"}\n`;
    writeFileSync(main(), huge + line(), { mode: 0o600 });
    const { source, mapper } = makeSource(db());
    const report = await replaySpool({ spoolDir, source });
    expect(report).toMatchObject({ invalidLines: 1, hooks: 1 });
    expect(mapper.calls).toHaveLength(1);
  });

  it("waits a bounded time on a live shim's lock and leaves the main file", async () => {
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const lock = join(spoolDir, "claude-code.lock");
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "pid"), `${holder.pid}\n`);
      writeFileSync(main(), line(), { mode: 0o600 });
      const own = uuid();
      writeFileSync(join(spoolDir, `claude-code.${own}.jsonl`), line({ sourceEventId: own }), {
        mode: 0o600,
      });

      const started = performance.now();
      const { source, mapper } = makeSource(db());
      const report = await replaySpool({ spoolDir, source, lockWaitMs: 300 });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(report.mainFile).toBe("busy");
      expect(mapper.calls.map((c) => c.sourceEventId)).toEqual([own]);
      expect(existsSync(main())).toBe(true);
      expect(existsSync(lock)).toBe(true);
    } finally {
      holder.kill();
    }
  });

  it("breaks a lock left by a dead shim and releases its own", async () => {
    const lock = join(spoolDir, "claude-code.lock");
    mkdirSync(lock, { mode: 0o700 });
    const dead = spawn("true", { stdio: "ignore" });
    await new Promise((resolve) => dead.on("exit", resolve));
    writeFileSync(join(lock, "pid"), `${dead.pid}\n`);
    writeFileSync(main(), line(), { mode: 0o600 });
    const report = await replaySpool({
      spoolDir,
      source: makeSource(db()).source,
      lockWaitMs: 300,
    });
    expect(report).toMatchObject({ mainFile: "claimed", hooks: 1 });
    expect(spoolNames()).toEqual([]);
  });

  it("never claims the main file while a shim that won the pid race holds the lock", async () => {
    // M7.32: under uutils mkdir 0.8.0 a shim can report success for the directory the engine
    // just made and create the pid file first. A copy of the real shim pauses holding it.
    const script = readFileSync(SHIM, "utf8");
    const taken = "  lock_held=yes\n";
    expect(script.split(taken)).toHaveLength(2);
    const paused = join(root, "paused-shim.sh");
    writeFileSync(
      paused,
      script.replace(
        taken,
        `${taken}  : >"$home/taken"; while [ ! -e "$home/go" ]; do sleep 0.01; done\n`,
      ),
    );
    const real = spawnSync("sh", ["-c", "command -v mkdir"], { encoding: "utf8" }).stdout.trim();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "mkdir"),
      `#!/bin/sh\nfor d; do :; done\n'${real}' "$@" 2>/dev/null || [ -d "$d" ]\n`,
    );
    chmodSync(join(bin, "mkdir"), 0o755);
    writeFileSync(join(root, "hook.json"), JSON.stringify(hook()));
    writeFileSync(main(), line(), { mode: 0o600 });

    let shim: ChildProcess | undefined;
    let exited: Promise<unknown> = Promise.resolve();
    seam.afterMkdir = (path) => {
      if (shim !== undefined || path !== join(spoolDir, "claude-code.lock")) return;
      const input = openSync(join(root, "hook.json"), "r");
      shim = spawn("/bin/sh", [paused], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          HOME: root,
          TASKVILLE_HOME: root,
        },
        stdio: [input, "ignore", "ignore"],
      });
      closeSync(input);
      const child = shim;
      exited = new Promise((resolve) => child.on("exit", resolve));
      // Synchronous on purpose: the engine is between its mkdir and its pid write.
      spawnSync("sh", [
        "-c",
        'i=0; while [ ! -e "$1" ] && [ "$i" -lt 1000 ]; do sleep 0.01; i=$((i + 1)); done',
        "sh",
        join(root, "taken"),
      ]);
    };
    try {
      const { source, mapper } = makeSource(db());
      const report = await replaySpool({ spoolDir, source, lockWaitMs: 300 });
      seam.afterMkdir = undefined;

      expect(shim?.pid).toBeDefined();
      expect(report.mainFile).toBe("busy");
      expect(mapper.calls).toHaveLength(0);
      const pid = readFileSync(join(spoolDir, "claude-code.lock", "pid"), "utf8");
      expect(pid).toBe(`${shim?.pid}\n`);
      // The shim appends and releases; the next replay takes the main file with both hooks.
      writeFileSync(join(root, "go"), "");
      await exited;
      const again = await replaySpool({ spoolDir, source, lockWaitMs: 300 });
      expect(again).toMatchObject({ mainFile: "claimed", hooks: 2 });
      expect(spoolNames()).toEqual([]);
    } finally {
      shim?.kill();
    }
  }, 15_000);

  it("never breaks a lock while a shim holds the break lock it claimed first", async () => {
    const lock = join(spoolDir, "claude-code.lock");
    mkdirSync(lock, { mode: 0o700 });
    const dead = spawn("true", { stdio: "ignore" });
    await new Promise((resolve) => dead.on("exit", resolve));
    writeFileSync(join(lock, "pid"), `${dead.pid}\n`);
    writeFileSync(main(), line(), { mode: 0o600 });
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const breaker = `${lock}.break`;
      // A shim whose mkdir is not atomic claims the break lock the engine just made.
      seam.afterMkdir = (path) => {
        if (path === breaker && !existsSync(join(breaker, "pid"))) {
          writeFileSync(join(breaker, "pid"), `${holder.pid}\n`, { flag: "wx" });
        }
      };
      const report = await replaySpool({
        spoolDir,
        source: makeSource(db()).source,
        lockWaitMs: 300,
      });
      seam.afterMkdir = undefined;
      expect(report.mainFile).toBe("busy");
      expect(readFileSync(join(lock, "pid"), "utf8")).toBe(`${dead.pid}\n`);
      expect(readFileSync(join(breaker, "pid"), "utf8")).toBe(`${holder.pid}\n`);
    } finally {
      holder.kill();
    }
  });

  it("releases only its own pid, never a shim's that claimed the lock as it went", async () => {
    writeFileSync(main(), line(), { mode: 0o600 });
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      // After the engine's pid file goes and before its directory does, a shim whose mkdir is
      // not atomic claims the lock.
      seam.lockPidGone = (dir) => {
        writeFileSync(join(dir, "pid"), `${holder.pid}\n`, { flag: "wx" });
      };
      const report = await replaySpool({
        spoolDir,
        source: makeSource(db()).source,
        lockWaitMs: 300,
      });
      seam.lockPidGone = undefined;
      expect(report.mainFile).toBe("claimed");
      const lock = join(spoolDir, "claude-code.lock");
      expect(readFileSync(join(lock, "pid"), "utf8")).toBe(`${holder.pid}\n`);
    } finally {
      holder.kill();
    }
  });

  it("clears a break lock a killed shim left behind, but not a fresh one", async () => {
    const breaker = join(spoolDir, "claude-code.lock.break");
    mkdirSync(breaker, { mode: 0o700 });
    await replaySpool({ spoolDir, source: makeSource(db()).source });
    expect(existsSync(breaker)).toBe(true);

    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(breaker, old, old);
    await replaySpool({ spoolDir, source: makeSource(db()).source });
    expect(existsSync(breaker)).toBe(false);
  });

  it("does not follow a symlinked spool file", async () => {
    const outside = join(root, "outside.jsonl");
    const text = line();
    writeFileSync(outside, text);
    symlinkSync(outside, join(spoolDir, `claude-code.${uuid()}.jsonl`));
    const { source, mapper } = makeSource(db());
    const report = await replaySpool({ spoolDir, source });
    expect(mapper.calls).toHaveLength(0);
    expect(report.hooks).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe(text);
  });

  it("returns an empty report when there is no spool directory", async () => {
    rmSync(spoolDir, { recursive: true });
    const report = await replaySpool({ spoolDir, source: makeSource(db()).source });
    expect(report).toMatchObject({ mainFile: "absent", files: 0, hooks: 0, failed: false });
  });

  it("logs counts only", async () => {
    writeFileSync(main(), line() + line({ payload: null, payloadBytesAtLeast: 9_000_000 }), {
      mode: 0o600,
    });
    const log = captureLogger();
    await replaySpool({ spoolDir, source: makeSource(db()).source, logger: log.logger });
    const text = log.text();
    expect(text).toContain("spool replayed");
    expect(text).not.toContain("do the thing");
    expect(text).not.toContain("sess-1");
  });
});

describe("ClaudeCodeSource receivedAt override", () => {
  it("passes a replay's receivedAt to the mapper instead of the engine clock", async () => {
    const { source, mapper } = makeSource(db());
    await source.ingestHook({
      sourceEventId: "u-1",
      payload: hook(),
      late: true,
      receivedAt: SPOOLED_AT,
    });
    await source.ingestHook({ sourceEventId: "u-2", payload: hook() });
    expect(mapper.calls.map((c) => c.receivedAt)).toEqual([SPOOLED_AT, fixedNow().toISOString()]);
    expect(fixedNow().toISOString()).toBe(T0);
  });

  it("cannot be set over HTTP: the route refuses a receivedAt key", async () => {
    const { app } = makeApp();
    const { source, mapper } = makeSource(db());
    registerClaudeCodeRoutes(app, source);
    const res = await app.request(
      `http://127.0.0.1:4807${CLAUDE_CODE_HOOKS_PATH}`,
      postJson(
        { sourceEventId: uuid(), payload: hook(), receivedAt: SPOOLED_AT },
        bearer(CLI_TOKEN),
      ),
    );
    expect(res.status).toBe(400);
    expect(mapper.calls).toHaveLength(0);
  });
});

// M7.13 (#214): a drain must not hold the event loop. `serve` drains after listen; one run
// ingests up to 2,000 hooks, and a loop of awaited, already-settled promises never lets the
// event loop reach its I/O and timer phases, so live hook requests wait (measured ~2.9 s).
// The pins count hooks per event-loop turn instead of elapsed time (L-206): a setImmediate
// probe ticks once per turn, and every ingest records the tick it ran in.
describe("drainSpool yields to live hooks (M7.13)", () => {
  /** Hooks one event-loop turn may ingest: about 50 ms at the measured 1.35 ms per hook. */
  const MAX_HOOKS_PER_TURN = 50;

  /** Ticks a counter once per event-loop turn (setImmediate runs after the poll phase). */
  function startProbe() {
    let ticks = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    return {
      ticks: () => ticks,
      stop: () => {
        running = false;
      },
    };
  }

  const stamp = (i: number) =>
    new Date(Date.parse("2026-10-31T00:00:00Z") + i * 1000).toISOString();

  function writeSpool(count: number, base = 0): string[] {
    const ids = Array.from({ length: count }, () => uuid());
    writeFileSync(
      main(),
      ids.map((sourceEventId, i) => line({ sourceEventId, spooledAt: stamp(base + i) })).join(""),
      { mode: 0o600 },
    );
    return ids;
  }

  /** A source that settles at once, as the mapper-free part of a real ingest does. */
  function instantSource() {
    const seen: { id: string; tick: number }[] = [];
    let tickOf = () => 0;
    const source = {
      ingestHook: (input: HookInput) => {
        seen.push({ id: input.sourceEventId, tick: tickOf() });
        return Promise.resolve({
          projectId: "repo",
          results: [{ status: "accepted" }],
          heads: {},
        });
      },
    } as unknown as ClaudeCodeSource;
    return {
      source,
      seen,
      bind: (ticks: () => number) => {
        tickOf = ticks;
      },
    };
  }

  /** The longest run of consecutive ingests that shared one event-loop turn. */
  function longestTurn(seen: { tick: number }[]): number {
    let longest = 0;
    let run = 0;
    let last = -1;
    for (const { tick } of seen) {
      run = tick === last ? run + 1 : 1;
      last = tick;
      longest = Math.max(longest, run);
    }
    return longest;
  }

  it("never ingests more than a few dozen hooks without a turn of the event loop", async () => {
    const ids = writeSpool(8000);
    const fake = instantSource();
    const probe = startProbe();
    fake.bind(probe.ticks);
    try {
      await drainSpool({ spoolDir, source: fake.source, pauseMs: 1 });
    } finally {
      probe.stop();
    }
    expect(fake.seen).toHaveLength(ids.length);
    expect(longestTurn(fake.seen)).toBeLessThanOrEqual(MAX_HOOKS_PER_TURN);
  });

  it("ingests a live hook posted mid-drain as live, within a few dozen spooled hooks", async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../../../fixtures/claude-code/permission/notification-permission-prompt.json",
        ),
        "utf8",
      ),
    ) as { body: Record<string, unknown> };
    const livePayload = { ...fixture.body, session_id: "live-sess", cwd: "/work/repo" };
    const liveId = uuid();

    const real = realSource();
    const { app } = makeApp();
    let ingested = 0;
    let atLive = -1;
    let arrive: (res: Promise<Response>) => void = () => {};
    const posted = new Promise<Response>((resolve) => {
      arrive = (res) => resolve(res);
    });
    const OPEN_AFTER = 10;
    const wrapped = {
      ingestHook: (input: HookInput) => {
        if (input.sourceEventId === liveId) {
          atLive = ingested;
        } else {
          ingested += 1;
          if (ingested === OPEN_AFTER) {
            // A live request reaches the engine as an I/O callback, a later turn of the loop.
            setImmediate(() => {
              arrive(
                Promise.resolve(
                  app.request(
                    `http://127.0.0.1:4807${CLAUDE_CODE_HOOKS_PATH}`,
                    postJson({ sourceEventId: liveId, payload: livePayload }, bearer(CLI_TOKEN)),
                  ),
                ),
              );
            });
          }
        }
        return real.ingestHook(input);
      },
    } as unknown as ClaudeCodeSource;
    registerClaudeCodeRoutes(app, wrapped);

    const count = 600;
    writeSpool(count);
    const total = await drainSpool({ spoolDir, source: wrapped, maxHooks: count, pauseMs: 1 });
    expect(total).toMatchObject({ hooks: count, failed: false });
    const res = await posted;
    expect(res.status).toBe(200);

    // The live hook ran soon after it arrived, not after the rest of the run.
    expect(atLive).toBeGreaterThanOrEqual(OPEN_AFTER);
    expect(atLive - OPEN_AFTER).toBeLessThanOrEqual(MAX_HOOKS_PER_TURN);

    const liveOpened = repoEvents().filter(
      (e) => e.type === "request.opened" && e.sourceEventId.startsWith(liveId),
    );
    expect(liveOpened).toHaveLength(1);
    expect(liveOpened[0]?.late).toBe(false);
    const state = db().projection<ProjectState>("repo")?.state;
    const needsYou = attention(state as ProjectState, Date.parse("2026-10-31T12:00:00Z")).filter(
      (a) => a.level === "needs_you",
    );
    expect(needsYou.length).toBeGreaterThan(0);
  });

  it("still ingests every spooled hook exactly once, oldest first, and empties the spool", async () => {
    const ids = writeSpool(5000);
    const fake = instantSource();
    const probe = startProbe();
    fake.bind(probe.ticks);
    let total: SpoolReplayReport;
    try {
      total = await drainSpool({ spoolDir, source: fake.source, pauseMs: 1 });
    } finally {
      probe.stop();
    }
    expect(total).toMatchObject({ hooks: ids.length, deferredFiles: 0, failed: false });
    expect(fake.seen.map((s) => s.id)).toEqual(ids);
    expect(new Set(fake.seen.map((s) => s.id)).size).toBe(ids.length);
    expect(spoolNames()).toEqual([]);
  });
});
