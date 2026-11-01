import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandService, registerCommandRoutes } from "../../src/commands/index.ts";
import type { OpenSessionExecFile } from "../../src/commands/open-session.ts";
import { ENGINE_SOURCE_ID } from "../../src/storage/index.ts";
import { ORIGIN, postJson, sessionHeaders } from "../http/helpers.ts";
import { BASE, bootInProcess } from "../stream/helpers.ts";
import {
  bootHarness,
  commandEvents,
  type Harness,
  json,
  openBody,
  PROJECT,
  REQUEST_ID,
  requestOpened,
  SESSION_ID,
  type SeedEvent,
  seedEvents,
  sessionStarted,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 command service, session.open that an engine stop left behind (fixes b491245 and b2725b1).
//
// An opener only ever runs inside the process that started it. A session.open still `requested`
// that this process is not running was cut short by an engine stop, so:
//   - a repeated POST with its key ends it as failed (502 opener_failed), never command_in_flight
//     forever, and does not run the opener again;
//   - at service start, such commands are ended (command.failed) so GET shows a terminal status.
// A running opener in THIS process still answers command_in_flight to a repeat of its key.
//
// After a restart, a succeeded session.open is still `succeeded` on GET and on a repeated POST,
// but with no `result`: the log cannot carry it (command.succeeded is strict { commandId }) and
// the service does not guess one (CTO decision on #52).

const dbPath = useDbPath();
let harness: Harness | undefined;
let reopened: { close(): void } | undefined;
let root = "";
let cwd = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "taskville-recover-")));
  cwd = join(root, "repo");
  mkdirSync(cwd);
});
afterEach(() => {
  reopened?.close();
  reopened = undefined;
  harness?.engine.close();
  harness = undefined;
  rmSync(root, { recursive: true, force: true });
});

const TEMPLATE = ["/usr/bin/open", "-a", "Terminal", "{cwd}", "--id={sessionId}"];
const STALE_ID = "stale-cmd";

/** A session.open the log shows as requested with no outcome, as an engine stop leaves it. */
function staleOpen(): SeedEvent {
  return {
    type: "command.requested",
    sourceId: ENGINE_SOURCE_ID,
    payload: {
      commandId: STALE_ID,
      commandType: "session.open",
      requestId: REQUEST_ID,
      payload: { sessionId: SESSION_ID },
      idempotencyKey: "open-1",
    },
  };
}

function boot(options: { execFile?: OpenSessionExecFile; seed?: SeedEvent[] } = {}): Harness {
  harness = bootHarness(dbPath(), {
    sessionOpener: TEMPLATE,
    roots: [root],
    ...(options.execFile === undefined ? {} : { execFile: options.execFile }),
    seed: [sessionStarted(cwd), requestOpened({}), ...(options.seed ?? [])],
  });
  return harness;
}

/** The command.* event types only (a restart also expires the open request, which is not ours). */
const commandTypes = (engine: Parameters<typeof commandEvents>[0]): string[] =>
  types(commandEvents(engine)).filter((type) => type.startsWith("command."));

/** Stops the engine in `h` and starts a new one on the same database, as a restart does. */
function restart(h: Harness) {
  h.engine.close();
  harness = undefined;
  const booted = bootInProcess(dbPath());
  reopened = booted.engine;
  const execFile = vi.fn<OpenSessionExecFile>(async () => undefined);
  const service = createCommandService({
    engine: booted.engine,
    bridge: { lookup: () => undefined, decide: () => false },
    opener: { config: { sessionOpener: TEMPLATE }, execFile },
  });
  registerCommandRoutes(booted.app, service);
  const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";
  return {
    engine: booted.engine,
    execFile,
    post: (body: unknown) =>
      Promise.resolve(
        booted.app.request(
          `${BASE}/v1/commands`,
          postJson(body, { ...sessionHeaders(session), Origin: ORIGIN }),
        ),
      ),
    get: (id: string) =>
      Promise.resolve(
        booted.app.request(`${BASE}/v1/commands/${id}`, { headers: sessionHeaders(session) }),
      ),
  };
}

describe("session.open: a command left requested by an engine stop", () => {
  it("ends it as failed on a repeated POST (502 opener_failed), without running the opener", async () => {
    const h = boot();
    // Appended after the service started, so only the repeat POST can notice it.
    seedEvents(h.engine, PROJECT, [staleOpen()]);
    expect((await json(await h.get(STALE_ID))).command?.status).toBe("requested");

    const res = await h.post(openBody());
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error?.code).toBe("opener_failed");
    expect(body.command).toMatchObject({ id: STALE_ID, status: "failed" });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(types(commandEvents(h.engine))).toEqual(["command.requested", "command.failed"]);
    expect(commandEvents(h.engine).at(-1)?.payload).toMatchObject({ commandId: STALE_ID });

    // The next repeat replays the failure; it is not in flight and not ended a second time.
    const again = await h.post(openBody());
    expect(again.status).toBe(502);
    expect((await json(again)).error?.code).toBe("opener_failed");
    expect(types(commandEvents(h.engine))).toEqual(["command.requested", "command.failed"]);
    expect((await json(await h.get(STALE_ID))).command?.status).toBe("failed");
  });

  it("still answers command_in_flight to a repeated key while this process is running the opener", async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = boot({
      execFile: () => {
        started();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = h.post(openBody());
    await running;
    const repeat = await h.post(openBody());
    expect(repeat.status).toBe(409);
    expect((await json(repeat)).error?.code).toBe("command_in_flight");
    expect(types(commandEvents(h.engine))).toEqual(["command.requested"]);

    release();
    expect((await json(await first)).command?.status).toBe("succeeded");
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("ends it as failed when the service starts, so GET shows a terminal status", async () => {
    const h = boot({ seed: [staleOpen()] });
    const after = restart(h);

    const got = await json(await after.get(STALE_ID));
    expect(got.command).toMatchObject({ id: STALE_ID, status: "failed" });
    expect(commandTypes(after.engine)).toEqual(["command.requested", "command.failed"]);
    const failed = commandEvents(after.engine).find((e) => e.type === "command.failed");
    expect(failed?.payload).toMatchObject({
      commandId: STALE_ID,
      reason: "The engine stopped before the outcome was recorded; the session may have opened",
    });
    expect(after.execFile).not.toHaveBeenCalled();
  });

  it("leaves a session.open that already has an outcome alone at service start", async () => {
    const h = boot();
    const posted = (await json(await h.post(openBody()))).command;
    expect(posted?.status).toBe("succeeded");
    const before = commandTypes(h.engine);

    const after = restart(h);
    expect(commandTypes(after.engine)).toEqual(before);
    expect((await json(await after.get(posted?.id ?? ""))).command?.status).toBe("succeeded");
  });
});

describe("session.open: after a restart a succeeded command carries no guessed result", () => {
  it("answers GET and a repeated POST with status succeeded and no result, and runs nothing", async () => {
    const h = boot();
    const posted = (await json(await h.post(openBody()))).command;
    expect(posted).toMatchObject({ status: "succeeded", result: { outcome: "opened" } });

    const after = restart(h);
    const got = await after.get(posted?.id ?? "");
    expect(got.status).toBe(200);
    const view = (await json(got)).command;
    expect(view).toMatchObject({ id: posted?.id, status: "succeeded" });
    expect(view).not.toHaveProperty("result");

    const repeat = await after.post(openBody());
    expect(repeat.status).toBe(200);
    const replayed = (await json(repeat)).command;
    expect(replayed).toMatchObject({ id: posted?.id, status: "succeeded" });
    expect(replayed).not.toHaveProperty("result");
    expect(after.execFile).not.toHaveBeenCalled();
  });
});
