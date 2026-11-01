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
