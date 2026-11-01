import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_SOURCE_ID } from "../../src/storage/index.ts";
import {
  bootHarness,
  commandEvents,
  decideBody,
  type Harness,
  json,
  openBody,
  REQUEST_ID,
  requestOpened,
  sessionStarted,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 review fix (roborev 5906 HIGH; ARCHITECTURE.md 9.2 "every command targets an open
// PendingRequest", 2.4 "buttons disable" once answered or expired).
//
// session.open requires `requestId` to be an OPEN request of the same project whose `sessionId`
// equals the command's `sessionId`:
//   - no such request                    404 unknown_request, nothing recorded, opener never runs
//   - request closed (answered_here,     409 request_not_open: command.requested then
//     expired, ...)                          command.failed (like permission.decide), no opener
//   - request open but another session's 409 request_session_mismatch: command.requested then
//                                            command.failed, no opener
// A request the bridge did not hold (telemetry, answerable: false) is still a valid target: only
// permission.decide needs an answerable one. An idempotent replay is answered from the recorded
// command before these checks, so a repeat after the request closed returns the same command.

const dbPath = useDbPath();
let harness: Harness | undefined;
let root = "";
let cwd = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "taskville-open-req-")));
  cwd = join(root, "repo");
  mkdirSync(cwd);
});
afterEach(() => {
  harness?.engine.close();
  harness = undefined;
  rmSync(root, { recursive: true, force: true });
});

const TEMPLATE = ["/usr/bin/open", "-a", "Terminal", "{cwd}", "--id={sessionId}"];

function boot(options: Parameters<typeof bootHarness>[1] = {}): Harness {
  harness = bootHarness(dbPath(), {
    sessionOpener: TEMPLATE,
    roots: [root],
    seed: [sessionStarted(cwd), requestOpened({})],
    ...options,
  });
  return harness;
}

describe("session.open: the request must be open and the session's own", () => {
  it("runs the opener for an open request of the same session", async () => {
    const h = boot();
    const res = await h.post(openBody());
    expect(res.status).toBe(200);
    expect((await json(res)).command?.status).toBe("succeeded");
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("also accepts an open request the bridge never held (telemetry, not answerable)", async () => {
    const h = boot({
      seed: [sessionStarted(cwd), requestOpened({ sourceId: "claude-code" })],
    });
    const res = await h.post(openBody());
    expect(res.status).toBe(200);
    expect((await json(res)).command?.status).toBe("succeeded");
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("answers 404 unknown_request and records and runs nothing for a request the project never had", async () => {
    const h = boot();
    const res = await h.post(openBody({ requestId: "ghost" }));
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("unknown_request");
    expect(h.execFile).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("fails an expired request as request_not_open (requested, then failed) and runs nothing", async () => {
    const h = boot({
      seed: [
        sessionStarted(cwd),
        requestOpened({}),
        {
          type: "request.expired",
          payload: { requestId: REQUEST_ID },
          sourceId: ENGINE_SOURCE_ID,
        },
      ],
    });
    const res = await h.post(openBody());
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe("request_not_open");
    expect(body.command?.status).toBe("failed");
    expect(h.execFile).not.toHaveBeenCalled();
    const events = commandEvents(h.engine).filter((e) => e.type.startsWith("command."));
    expect(types(events)).toEqual(["command.requested", "command.failed"]);
    expect(events[1]?.payload).toMatchObject({ commandId: body.command?.id });
    const got = await json(await h.get(body.command?.id ?? ""));
    expect(got.command?.status).toBe("failed");
  });

  it("fails a request already answered here as request_not_open and runs nothing", async () => {
    const h = boot();
    expect((await h.post(decideBody())).status).toBe(200);
    const res = await h.post(openBody());
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe("request_not_open");
    expect(body.command?.status).toBe("failed");
    expect(h.execFile).not.toHaveBeenCalled();
    expect(types(commandEvents(h.engine)).slice(3)).toEqual([
      "command.requested",
      "command.failed",
    ]);
  });

  it("fails an open request that belongs to another session as 409 request_session_mismatch, and runs nothing", async () => {
    const other = join(root, "other");
    mkdirSync(other);
    const h = boot({
      seed: [
        sessionStarted(cwd),
        sessionStarted(other, "sess-2", "agent-2"),
        // req-1 belongs to SESSION_ID; the command names sess-2, which is recorded and has a cwd.
        requestOpened({}),
      ],
    });
    const res = await h.post(openBody({ sessionId: "sess-2" }));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe("request_session_mismatch");
    expect(body.command?.status).toBe("failed");
    expect(h.execFile).not.toHaveBeenCalled();
    expect(types(commandEvents(h.engine))).toEqual(["command.requested", "command.failed"]);
  });

  it("replays a succeeded command for the same key even after its request closed", async () => {
    const h = boot();
    const first = await json(await h.post(openBody()));
    expect(first.command?.status).toBe("succeeded");
    expect((await h.post(decideBody())).status).toBe(200);

    const repeat = await h.post(openBody());
    expect(repeat.status).toBe(200);
    const again = await json(repeat);
    expect(again.command?.id).toBe(first.command?.id);
    expect(again.command?.status).toBe("succeeded");
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });
});
