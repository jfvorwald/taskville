import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASE,
  BRIDGE_TOKEN,
  bearer,
  bootHarness,
  CLI_TOKEN,
  commandEvents,
  type Harness,
  json,
  ORIGIN,
  openBody,
  REQUEST_ID,
  requestOpened,
  SESSION_ID,
  sessionStarted,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 command service, session.open (ARCHITECTURE.md 2.4 and 9.2).
//
// Request:  POST /v1/commands { type: "session.open", projectId, sessionId, requestId,
//   idempotencyKey, context? }. `requestId` is the needs-you request whose card was clicked; it
//   must be an OPEN request of the same session (CTO decision on roborev 5906; see
//   command-session-open-request.test.ts). The working directory is read from the RECORDED
//   session state (session.started workingDirectory), never from the body: a body with `cwd`,
//   `template`, or `sessionOpener` gets 400 bad_request and nothing runs. It must also lie inside
//   one of the project's configured roots (see command-open-cwd-roots.test.ts); these tests
//   configure the project with `roots: [root]` and use a realpath'd temp root.
// Success:  200 { command: { id, type, requestId, status: "succeeded",
//   result: { outcome: "opened" | "copy-only", sessionId, cwd } } }
//   events: command.requested, command.delivered, command.succeeded
// Failure:  502 { error: { code: "opener_failed", message }, command: { status: "failed" } }
//   message is the non-secret message from openSession; raw errors are never echoed (response or log).
// Unknown session: 404 unknown_session, nothing recorded or run.
// One opener in flight per session: a second click with a different key gets 409 command_in_flight.
// The service passes isDirectory: defaultIsDirectory (a cwd that is a file never reaches the opener).

const dbPath = useDbPath();
let harness: Harness | undefined;
let cwd = "";
let root = "";
beforeEach(() => {
  // Real path: the opener cwd is resolved with realpath (tmpdir is a symlink on macOS).
  root = realpathSync(mkdtempSync(join(tmpdir(), "taskville-open-")));
  cwd = join(root, "repo");
  mkdirSync(cwd);
});
afterEach(() => {
  harness?.engine.close();
  harness = undefined;
  rmSync(root, { recursive: true, force: true });
});

function boot(options: Parameters<typeof bootHarness>[1] = {}): Harness {
  harness = bootHarness(dbPath(), {
    seed: [sessionStarted(cwd), requestOpened({})],
    roots: [root],
    ...options,
  });
  return harness;
}

const TEMPLATE = ["/usr/bin/open", "-a", "Terminal", "{cwd}", "--id={sessionId}"];

describe("session.open: success", () => {
  it("returns the session ID and recorded cwd to copy, and runs nothing, when no opener is configured", async () => {
    const h = boot({ sessionOpener: null });
    const res = await h.post(openBody());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.command).toMatchObject({
      type: "session.open",
      requestId: REQUEST_ID,
      status: "succeeded",
      result: { outcome: "copy-only", sessionId: SESSION_ID, cwd },
    });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(types(commandEvents(h.engine))).toEqual([
      "command.requested",
      "command.delivered",
      "command.succeeded",
    ]);
  });

  it("runs the configured opener once with the cwd from the recorded session", async () => {
    const h = boot({ sessionOpener: TEMPLATE });
    const res = await h.post(openBody());
    expect(res.status).toBe(200);
    const posted = (await json(res)).command;
    expect(posted).toMatchObject({
      status: "succeeded",
      result: { outcome: "opened", sessionId: SESSION_ID, cwd },
    });
    expect(h.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = h.execFile.mock.calls[0] ?? [];
    expect(file).toBe("/usr/bin/open");
    expect(args).toEqual(["-a", "Terminal", cwd, `--id=${SESSION_ID}`]);
    expect(options).toMatchObject({ shell: false });
    expect(types(commandEvents(h.engine))).toEqual([
      "command.requested",
      "command.delivered",
      "command.succeeded",
    ]);
    const got = await json(await h.get(posted?.id ?? ""));
    expect(got.command?.status).toBe("succeeded");
  });

  it("repeats nothing for a repeated key: same command, one opener run", async () => {
    const h = boot({ sessionOpener: TEMPLATE });
    const a = await json(await h.post(openBody()));
    const b = await json(await h.post(openBody()));
    expect(b.command?.id).toBe(a.command?.id);
    expect(h.execFile).toHaveBeenCalledTimes(1);
    const conflict = await h.post(openBody({ sessionId: "other" }));
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error?.code).toBe("idempotency_conflict");
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });
});

describe("session.open: the request never supplies the cwd or the template", () => {
  for (const extra of [
    { cwd: "/tmp/evil" },
    { template: ["/bin/sh", "-c", "id"] },
    { sessionOpener: ["/bin/sh", "-c", "id"] },
  ]) {
    it(`answers 400 bad_request for a body carrying ${Object.keys(extra)[0]}, and runs nothing`, async () => {
      const h = boot({ sessionOpener: TEMPLATE });
      const res = await h.post(openBody(extra));
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe("bad_request");
      expect(h.execFile).not.toHaveBeenCalled();
      expect(commandEvents(h.engine)).toEqual([]);
    });
  }

  it("answers 404 unknown_session when the session was never recorded, and runs nothing", async () => {
    const h = boot({ sessionOpener: TEMPLATE });
    const res = await h.post(openBody({ sessionId: "ghost" }));
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("unknown_session");
    expect(h.execFile).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("checks that the recorded cwd is a directory (isDirectory: defaultIsDirectory), so a file never reaches the opener", async () => {
    const script = join(root, "evil.command");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    const h = boot({
      sessionOpener: TEMPLATE,
      seed: [sessionStarted(script), requestOpened({})],
    });
    const res = await h.post(openBody());
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error?.code).toBe("opener_failed");
    expect(body.command?.status).toBe("failed");
    expect(h.execFile).not.toHaveBeenCalled();
    const events = commandEvents(h.engine);
    expect(events[0]?.type).toBe("command.requested");
    expect(events.at(-1)?.type).toBe("command.failed");
    expect(types(events)).not.toContain("command.succeeded");
  });
});

describe("session.open: failures are explained without leaking", () => {
  it("records command.failed with a non-secret message when the opener cannot start", async () => {
    const secret = "hunter2-token";
    const h = boot({
      sessionOpener: TEMPLATE,
      execFile: async () => {
        throw Object.assign(new Error(`spawn /opt/${secret}/opener ENOENT --key=${secret}`), {
          code: "ENOENT",
        });
      },
    });
    const res = await h.post(openBody());
    expect(res.status).toBe(502);
    const text = await res.text();
    const body = JSON.parse(text) as Awaited<ReturnType<typeof json>>;
    expect(body.error?.code).toBe("opener_failed");
    expect(body.error?.message).toEqual(expect.any(String));
    expect(body.command?.status).toBe("failed");
    expect(text).not.toContain(secret);

    const events = commandEvents(h.engine);
    expect(events[0]?.type).toBe("command.requested");
    expect(events.at(-1)?.type).toBe("command.failed");
    expect(events.at(-1)?.payload).toMatchObject({ commandId: body.command?.id });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("/opt/");
    expect(types(events)).not.toContain("command.succeeded");
  });
});

describe("session.open: one opener in flight per session", () => {
  it("answers a second click with a different key 409 command_in_flight while one runs, then allows a new one", async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = boot({
      sessionOpener: TEMPLATE,
      execFile: () => {
        started();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = h.post(openBody({ idempotencyKey: "open-a" }));
    await running;
    const second = await h.post(openBody({ idempotencyKey: "open-b" }));
    expect(second.status).toBe(409);
    expect((await json(second)).error?.code).toBe("command_in_flight");
    expect(h.execFile).toHaveBeenCalledTimes(1);

    release();
    const firstDone = await first;
    expect(firstDone.status).toBe(200);
    expect((await json(firstDone)).command?.status).toBe("succeeded");

    // The slot is free again once the opener finished.
    const third = h.post(openBody({ idempotencyKey: "open-c" }));
    await waitForCalls(h, 2);
    release();
    expect((await third).status).toBe(200);
    expect(h.execFile).toHaveBeenCalledTimes(2);
  });
});

describe("session.open: credentials and history", () => {
  it("refuses the CLI and bridge tokens and runs nothing", async () => {
    const h = boot({ sessionOpener: TEMPLATE });
    for (const token of [CLI_TOKEN, BRIDGE_TOKEN]) {
      const res = await h.app.request(`${BASE}/v1/commands`, {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify(openBody()),
      });
      expect(res.status).toBe(403);
      expect((await json(res)).error?.code).toBe("credential_not_allowed");
    }
    expect(h.execFile).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("rejects history context with 400 history_context_rejected and runs nothing", async () => {
    const h = boot({ sessionOpener: TEMPLATE });
    const res = await h.post(openBody({ context: { mode: "history" } }));
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("history_context_rejected");
    expect(h.execFile).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });
});

/** Waits (bounded) until the injected execFile has been called `count` times. */
async function waitForCalls(h: Harness, count: number): Promise<void> {
  for (let i = 0; i < 100 && h.execFile.mock.calls.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
