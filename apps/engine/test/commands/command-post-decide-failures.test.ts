import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_SOURCE_ID } from "../../src/storage/index.ts";
import {
  bootHarness,
  capturingLogger,
  commandEvents,
  decideBody,
  failAppend,
  type Harness,
  json,
  openBody,
  PROJECT,
  REQUEST_ID,
  requestOpened,
  restartService,
  SESSION_ID,
  type SeedEvent,
  seedEvents,
  sessionStarted,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 review fix (code review should-fix 3 and nit; security L6).
//
// A. Once `bridge.decide` returned true the agent has its answer, so a failure appending
//    `request.resolved` or `command.delivered` afterwards must not strand the command:
//      - the response is still 200 { command: { status: "delivered" } };
//      - the error is logged by NAME only (never its message);
//      - a retry with the same key returns the same command, 200 delivered, never
//        command_in_flight, and never calls the bridge again.
//    Failures are injected through the storage append seam (`failAppend` in helpers.ts).
// B. At service start, a permission.decide still `requested` (an engine stop between the
//    command.requested and the outcome) is ended as failed, and so is a session.open stuck in
//    `delivered`. A permission.decide that is `delivered` ("sent, unconfirmed") is left alone.
// C. A startup recovery that throws is logged by name and skipped: service creation does not
//    fail, and the other stale commands are still ended.

const dbPath = useDbPath();
let harness: Harness | undefined;
let reopened: { close(): void } | undefined;
afterEach(() => {
  reopened?.close();
  reopened = undefined;
  harness?.engine.close();
  harness = undefined;
});

const POISON = "disk-secret-detail-4711";

// Constitution IV: a command cut short by an engine stop is not presented as a known failure.
const DECIDE_UNKNOWN_REASON =
  "The engine stopped before the outcome was recorded; the decision may have reached Claude Code";
const OPEN_UNKNOWN_REASON =
  "The engine stopped before the outcome was recorded; the session may have opened";

describe("permission.decide: an append failure after the hook was answered", () => {
  for (const eventType of ["request.resolved", "command.delivered"]) {
    it(`still answers 200 delivered when ${eventType} cannot be appended, and logs the error name only`, async () => {
      const { logger, lines } = capturingLogger();
      harness = bootHarness(dbPath(), { logger });
      const h = harness;
      failAppend(h.engine.storage, eventType, { errName: "InjectedDiskError", errMessage: POISON });

      const res = await h.post(decideBody());
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.command).toMatchObject({
        type: "permission.decide",
        requestId: REQUEST_ID,
        status: "delivered",
      });
      expect(h.bridge.decide).toHaveBeenCalledTimes(1);
      const log = lines.join("\n");
      expect(log).toContain("InjectedDiskError");
      expect(log).not.toContain(POISON);
      expect(types(commandEvents(h.engine))).not.toContain("command.succeeded");
    });

    it(`returns the same delivered command for a retry of the key after a failed ${eventType} append`, async () => {
      harness = bootHarness(dbPath());
      const h = harness;
      failAppend(h.engine.storage, eventType);

      const first = await json(await h.post(decideBody()));
      const retry = await h.post(decideBody());
      expect(retry.status).toBe(200);
      const again = await json(retry);
      expect(again.error).toBeUndefined();
      expect(again.command?.id).toBe(first.command?.id);
      expect(again.command?.status).toBe("delivered");
      expect(h.bridge.decide).toHaveBeenCalledTimes(1);
      expect(
        types(commandEvents(h.engine)).filter((type) => type === "command.requested"),
      ).toHaveLength(1);
      const got = await json(await h.get(first.command?.id ?? ""));
      expect(got.command?.status).toBe("delivered");
    });
  }
});

/** A command the log shows as `requested`, as an engine stop leaves it. */
function requestedCommand(
  commandId: string,
  commandType: "permission.decide" | "session.open",
  idempotencyKey: string,
): SeedEvent {
  return {
    type: "command.requested",
    sourceId: ENGINE_SOURCE_ID,
    payload: {
      commandId,
      commandType,
      requestId: REQUEST_ID,
      payload:
        commandType === "session.open"
          ? { sessionId: SESSION_ID }
          : { decision: { behavior: "allow" } },
      idempotencyKey,
    },
  };
}

const delivered = (commandId: string): SeedEvent => ({
  type: "command.delivered",
  sourceId: ENGINE_SOURCE_ID,
  payload: { commandId },
});

describe("service start: commands an engine stop left half done", () => {
  /**
   * The half-done commands are appended AFTER the first service started, so only the service
   * that starts on the restart can notice them (the harness service ran its start-up pass on an
   * empty command list).
   */
  function boot(stale: SeedEvent[]): Harness {
    harness = bootHarness(dbPath(), {
      seed: [sessionStarted("/nonexistent/taskville-start"), requestOpened({})],
    });
    seedEvents(harness.engine, PROJECT, stale);
    return harness;
  }

  const status = async (after: ReturnType<typeof restartService>, id: string) =>
    (await json(await after.get(id))).command?.status;

  it("ends a permission.decide left requested as failed, without asking the bridge", async () => {
    const h = boot([requestedCommand("stale-decide", "permission.decide", "key-1")]);
    const after = restartService(h, dbPath());
    reopened = after.engine;
    harness = undefined;

    expect(await status(after, "stale-decide")).toBe("failed");
    const events = commandEvents(after.engine).filter((e) => e.type.startsWith("command."));
    expect(types(events)).toEqual(["command.requested", "command.failed"]);
    expect(events[1]?.payload).toMatchObject({
      commandId: "stale-decide",
      reason: DECIDE_UNKNOWN_REASON,
    });
    expect(after.decide).not.toHaveBeenCalled();
  });

  it("ends a session.open stuck in delivered as failed, without running the opener", async () => {
    const h = boot([
      requestedCommand("stuck-open", "session.open", "open-1"),
      delivered("stuck-open"),
    ]);
    const after = restartService(h, dbPath());
    reopened = after.engine;
    harness = undefined;

    expect(await status(after, "stuck-open")).toBe("failed");
    const events = commandEvents(after.engine).filter((e) => e.type.startsWith("command."));
    expect(types(events)).toEqual(["command.requested", "command.delivered", "command.failed"]);
    expect(events[2]?.payload).toMatchObject({
      commandId: "stuck-open",
      reason: OPEN_UNKNOWN_REASON,
    });
    expect(after.execFile).not.toHaveBeenCalled();
  });

  it("leaves a delivered permission.decide alone: sent, unconfirmed stays delivered", async () => {
    const h = boot([]);
    const posted = (await json(await h.post(decideBody()))).command;
    expect(posted?.status).toBe("delivered");
    const before = types(commandEvents(h.engine));

    const after = restartService(h, dbPath());
    reopened = after.engine;
    harness = undefined;

    expect(await status(after, posted?.id ?? "")).toBe("delivered");
    expect(types(commandEvents(after.engine))).toEqual(before);
  });

  it("ends a stale decide on start so a retry of its key is not command_in_flight", async () => {
    const h = boot([requestedCommand("stale-decide", "permission.decide", "key-1")]);
    const after = restartService(h, dbPath());
    reopened = after.engine;
    harness = undefined;

    const retry = await after.post(decideBody());
    const body = await json(retry);
    expect(body.error?.code).not.toBe("command_in_flight");
    expect(body.command).toMatchObject({ id: "stale-decide", status: "failed" });
    expect(after.decide).not.toHaveBeenCalled();
  });
});

describe("service start: a recovery that throws is logged and skipped", () => {
  it("creates the service anyway, logs the error name only, and still ends the other stale command", async () => {
    const { logger, lines } = capturingLogger();
    harness = bootHarness(dbPath(), {
      seed: [sessionStarted("/nonexistent/taskville-start"), requestOpened({})],
    });
    seedEvents(harness.engine, PROJECT, [
      requestedCommand("stale-1", "session.open", "open-1"),
      requestedCommand("stale-2", "session.open", "open-2"),
    ]);
    let restore = () => {};
    let after: ReturnType<typeof restartService> | undefined;
    expect(() => {
      after = restartService(harness as Harness, dbPath(), {
        logger,
        beforeService: (engine) => {
          restore = failAppend(engine.storage, "command.failed", {
            errName: "InjectedRecoveryError",
            errMessage: POISON,
          });
        },
      });
    }).not.toThrow();
    restore();
    harness = undefined;
    if (after === undefined) throw new Error("service was not created");
    reopened = after.engine;

    const log = lines.join("\n");
    expect(log).toContain("InjectedRecoveryError");
    expect(log).not.toContain(POISON);
    // One append was refused; the other stale command was still ended.
    const failed = commandEvents(after.engine).filter((e) => e.type === "command.failed");
    expect(failed).toHaveLength(1);
    // The service works: the command left requested is ended by a retry of its key.
    const first = await json(await after.get("stale-1"));
    const second = await json(await after.get("stale-2"));
    expect([first.command?.status, second.command?.status].sort()).toEqual(["failed", "requested"]);
    const stillRequested = first.command?.status === "requested" ? "open-1" : "open-2";
    const retry = await after.post(openBody({ idempotencyKey: stillRequested }));
    expect(retry.status).toBe(502);
    expect((await json(retry)).error?.code).toBe("opener_failed");
  });
});
