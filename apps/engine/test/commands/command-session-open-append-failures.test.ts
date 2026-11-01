import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootHarness,
  capturingLogger,
  commandEvents,
  failAppend,
  type Harness,
  json,
  openBody,
  requestOpened,
  SESSION_ID,
  sessionStarted,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 roborev 5930 finding 3 (CTO decision 2). Once the opener ran, the session may be open, so a
// failure appending `command.delivered` or `command.succeeded` afterwards must not turn into a 500
// or a recorded failure:
//   - the POST still answers 200 with status `succeeded` and the result (`opened` or `copy-only`);
//   - the error is logged by NAME only (never its message);
//   - a retry with the same key, in the same process, returns the same command (200 succeeded
//     with the result), never opener_failed, never command_in_flight, and does not run the opener
//     again;
//   - no command.failed is recorded for it.
// Failures are injected through the storage append seam (`failAppend` in helpers.ts).

const dbPath = useDbPath();
let harness: Harness | undefined;
let root = "";
let cwd = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "taskville-open-append-")));
  cwd = join(root, "repo");
  mkdirSync(cwd);
});
afterEach(() => {
  harness?.engine.close();
  harness = undefined;
  rmSync(root, { recursive: true, force: true });
});

const TEMPLATE = ["/usr/bin/open", "-a", "Terminal", "{cwd}", "--id={sessionId}"];
const POISON = "disk-secret-detail-4711";

const cases = [
  { label: "opened", sessionOpener: TEMPLATE },
  { label: "copy-only", sessionOpener: null },
] as const;

function boot(
  sessionOpener: string[] | null,
  logger?: ReturnType<typeof capturingLogger>["logger"],
): Harness {
  harness = bootHarness(dbPath(), {
    sessionOpener,
    roots: [root],
    seed: [sessionStarted(cwd), requestOpened({})],
    ...(logger === undefined ? {} : { logger }),
  });
  return harness;
}

describe("session.open: an append failure after the opener ran", () => {
  for (const { label, sessionOpener } of cases) {
    for (const eventType of ["command.delivered", "command.succeeded"]) {
      const result = { outcome: label, sessionId: SESSION_ID };

      it(`answers 200 succeeded with the ${label} result when ${eventType} cannot be appended, and logs the error name only`, async () => {
        const { logger, lines } = capturingLogger();
        const h = boot(sessionOpener as string[] | null, logger);
        failAppend(h.engine.storage, eventType, {
          errName: "InjectedDiskError",
          errMessage: POISON,
        });

        const res = await h.post(openBody());
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.error).toBeUndefined();
        expect(body.command).toMatchObject({
          type: "session.open",
          status: "succeeded",
          result: { ...result, cwd },
        });
        expect(h.execFile).toHaveBeenCalledTimes(label === "opened" ? 1 : 0);
        const log = lines.join("\n");
        expect(log).toContain("InjectedDiskError");
        expect(log).not.toContain(POISON);
        expect(types(commandEvents(h.engine))).not.toContain("command.failed");
      });

      it(`returns the same succeeded command for a retry of the key after a failed ${eventType} append (${label})`, async () => {
        const h = boot(sessionOpener as string[] | null);
        failAppend(h.engine.storage, eventType);

        const first = await json(await h.post(openBody()));
        expect(first.command?.status).toBe("succeeded");
        const callsAfterFirst = h.execFile.mock.calls.length;

        const retry = await h.post(openBody());
        expect(retry.status).toBe(200);
        const again = await json(retry);
        expect(again.error).toBeUndefined();
        expect(again.command).toMatchObject({
          id: first.command?.id,
          status: "succeeded",
          result: { ...result, cwd },
        });
        expect(h.execFile.mock.calls.length).toBe(callsAfterFirst);
        const events = types(commandEvents(h.engine));
        expect(events.filter((type) => type === "command.requested")).toHaveLength(1);
        expect(events).not.toContain("command.failed");
      });
    }
  }
});

// M4.03 roborev 5954 (medium). The bounded result memory (`maxRememberedResults`) must not evict a
// result whose outcome events were never appended: it is the only record that the opener ran, and
// forgetting it would make a retry of the key report a failure for a session that opened. Results
// the log also holds still go oldest first.
describe("session.open: the bounded result memory and an unrecorded outcome", () => {
  it("keeps the result of a command whose success append failed while recorded ones are evicted oldest first", async () => {
    const sessions = ["s0", "s1", "s2", "s3"];
    const seed = sessions.flatMap((id) => {
      const dir = join(root, id);
      mkdirSync(dir);
      return [
        sessionStarted(dir, id, `agent-${id}`),
        requestOpened({ requestId: `req-${id}`, sessionId: id, agentId: `agent-${id}` }),
      ];
    });
    harness = bootHarness(dbPath(), {
      sessionOpener: TEMPLATE,
      roots: [root],
      seed,
      serviceExtras: { maxRememberedResults: 2 },
    });
    const h = harness;
    const bodyFor = (id: string) =>
      openBody({ sessionId: id, requestId: `req-${id}`, idempotencyKey: `open-${id}` });

    // The first open's success append fails after the opener ran; the later ones are recorded.
    const restore = failAppend(h.engine.storage, "command.succeeded");
    const first = await json(await h.post(bodyFor("s0")));
    expect(first.command?.status).toBe("succeeded");
    restore();
    const ids: string[] = [first.command?.id ?? ""];
    for (const id of sessions.slice(1)) {
      const res = await h.post(bodyFor(id));
      expect(res.status).toBe(200);
      ids.push((await json(res)).command?.id ?? "");
    }
    expect(h.execFile).toHaveBeenCalledTimes(4);

    // The unrecorded result survived the eviction: a retry of its key is still the same succeeded
    // command with its result, and the opener is not run again.
    const retry = await h.post(bodyFor("s0"));
    expect(retry.status).toBe(200);
    const again = await json(retry);
    expect(again.error).toBeUndefined();
    expect(again.command).toMatchObject({
      id: ids[0],
      status: "succeeded",
      result: { outcome: "opened", sessionId: "s0", cwd: join(root, "s0") },
    });
    expect(h.execFile).toHaveBeenCalledTimes(4);
    expect(types(commandEvents(h.engine))).not.toContain("command.failed");

    // Recorded results are forgotten oldest first: s1 and s2 are gone, the newest (s3) is kept.
    const views = await Promise.all(ids.map(async (id) => (await json(await h.get(id))).command));
    expect(views[1]).toMatchObject({ id: ids[1], status: "succeeded" });
    expect(views[1]).not.toHaveProperty("result");
    expect(views[2]).toMatchObject({ id: ids[2], status: "succeeded" });
    expect(views[2]).not.toHaveProperty("result");
    expect(views[3]?.result).toMatchObject({ sessionId: "s3" });
  });
});
