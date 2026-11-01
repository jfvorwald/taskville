import { sseFrameSchema } from "@taskville/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DENY_MESSAGE_CHARS } from "../../src/commands/schema.ts";
import { ENGINE_SOURCE_ID } from "../../src/storage/index.ts";
import { SseReader, streamRequest } from "../stream/helpers.ts";
import {
  BASE,
  BRIDGE_TOKEN,
  bearer,
  bootHarness,
  CLI_TOKEN,
  commandEvents,
  decideBody,
  type Harness,
  json,
  ORIGIN,
  PROJECT,
  REQUEST_ID,
  requestOpened,
  sessionHeaders,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 command service, permission.decide (ARCHITECTURE.md 9, decision #116 D4, decision #271).
//
// Request:  POST /v1/commands, browser session + matching Origin, JSON body
//   { type: "permission.decide", projectId, requestId, idempotencyKey,
//     decision: { behavior: "allow" } | { behavior: "deny", message?: string },
//     context?: { mode: "live" | "history" } }          (unknown keys -> 400 bad_request)
// Success:  200 { command: { id, type, requestId, status: "delivered" } }
//   events: command.requested, request.resolved (answered_here), command.delivered
//   Never command.succeeded here: "sent, unconfirmed" (M4.04 owns telemetry confirmation).
// Failures: { error: { code, message }, command?: { id, status } }
//   404 unknown_project | unknown_request    no command recorded (no request to attach it to)
//   409 request_not_open                     command.requested, command.failed
//   422 not_answerable                       command.requested, command.unsupported
//   410 request_expired                      command.requested, command.expired
//   409 idempotency_conflict                 same key, different body: nothing recorded or sent
//   400 history_context_rejected             nothing recorded or sent
//   400 bad_request                          invalid body: nothing recorded or sent
// GET /v1/commands/:id -> 200 { command }, 404 unknown_command.
//
// request.resolved carries `decision: "allow" | "deny"` (the M4.02 field, on main now), asserted
// below for both choices. The choice is also asserted through the bridge call and through the
// audit payload of command.requested ({ payload: { decision: { behavior } } }).
//
// Limits: a body over 16 KiB is 413 payload_too_large; a deny note over MAX_DENY_MESSAGE_CHARS is
// 400 bad_request. The recorded state is checked before the bridge: a closed request the bridge no
// longer holds is request_not_open (409), not request_expired (410).

const dbPath = useDbPath();
let harness: Harness | undefined;
afterEach(() => {
  harness?.engine.close();
  harness = undefined;
});

function boot(options: Parameters<typeof bootHarness>[1] = {}): Harness {
  harness = bootHarness(dbPath(), options);
  return harness;
}

describe("credentials: only a paired browser session may command", () => {
  it("refuses the CLI token with credential_not_allowed and does nothing", async () => {
    const h = boot();
    for (const origin of [undefined, ORIGIN]) {
      const res = await h.app.request(`${BASE}/v1/commands`, {
        method: "POST",
        headers: {
          ...bearer(CLI_TOKEN),
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(decideBody()),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "credential_not_allowed", message: expect.any(String) },
      });
    }
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("refuses the bridge token on POST and both tokens on GET", async () => {
    const h = boot();
    const post = await h.app.request(`${BASE}/v1/commands`, {
      method: "POST",
      headers: { ...bearer(BRIDGE_TOKEN), "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(decideBody()),
    });
    expect(post.status).toBe(403);
    for (const token of [CLI_TOKEN, BRIDGE_TOKEN]) {
      const get = await h.app.request(`${BASE}/v1/commands/anything`, { headers: bearer(token) });
      expect(get.status).toBe(403);
    }
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("refuses a browser session without a matching Origin", async () => {
    const h = boot();
    const none = await h.app.request(`${BASE}/v1/commands`, {
      method: "POST",
      headers: { ...sessionHeaders(h.session), "Content-Type": "application/json" },
      body: JSON.stringify(decideBody()),
    });
    expect(none.status).toBe(403);
    const res = await h.post(decideBody(), { Origin: "http://localhost:3000" });
    expect(res.status).toBe(403);
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("answers 401 to a request with no credential", async () => {
    const h = boot();
    const res = await h.app.request(`${BASE}/v1/commands`, {
      method: "POST",
      headers: {
        Host: "127.0.0.1:4807",
        Origin: ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(decideBody()),
    });
    expect(res.status).toBe(401);
    expect(h.bridge.decide).not.toHaveBeenCalled();
  });
});

describe("permission.decide: delivery", () => {
  it("allows a held request: bridge decision once, then requested, resolved, delivered", async () => {
    const h = boot();
    const res = await h.post(decideBody());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.command).toMatchObject({
      type: "permission.decide",
      requestId: REQUEST_ID,
      status: "delivered",
    });
    const commandId = body.command?.id ?? "";
    expect(commandId).not.toBe("");

    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, { behavior: "allow" });

    const events = commandEvents(h.engine);
    expect(types(events)).toEqual(["command.requested", "request.resolved", "command.delivered"]);
    expect(events[0]?.payload).toMatchObject({
      commandId,
      commandType: "permission.decide",
      requestId: REQUEST_ID,
      idempotencyKey: "key-1",
      payload: { decision: { behavior: "allow" } },
    });
    expect(events[1]?.payload).toEqual({
      requestId: REQUEST_ID,
      resolution: "answered_here",
      decision: "allow",
    });
    expect(events[2]?.payload).toEqual({ commandId });
    for (const event of events.filter((e) => e.type.startsWith("command."))) {
      expect(event.sourceId).toBe(ENGINE_SOURCE_ID);
    }
  });

  it("never reports success for a decision: sent, unconfirmed (decision #116 D4)", async () => {
    const h = boot();
    const body = await json(await h.post(decideBody()));
    expect(body.command?.status).toBe("delivered");
    expect(types(commandEvents(h.engine))).not.toContain("command.succeeded");
    const again = await json(await h.get(body.command?.id ?? ""));
    expect(again.command?.status).toBe("delivered");
  });

  it("passes a deny and its optional note to the bridge", async () => {
    const h = boot();
    const res = await h.post(
      decideBody({ decision: { behavior: "deny", message: "not this one" } }),
    );
    expect(res.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, {
      behavior: "deny",
      message: "not this one",
    });
    const events = commandEvents(h.engine);
    expect(events[0]?.payload).toMatchObject({
      payload: { decision: { behavior: "deny" } },
    });
    expect(events[1]?.type).toBe("request.resolved");
    expect(events[1]?.payload).toEqual({
      requestId: REQUEST_ID,
      resolution: "answered_here",
      decision: "deny",
    });
  });

  it("sends the hook message 'Denied in Taskville' for a deny without a note", async () => {
    const h = boot();
    const res = await h.post(decideBody({ decision: { behavior: "deny" } }));
    expect(res.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, {
      behavior: "deny",
      message: "Denied in Taskville",
    });
  });

  it("never stores the deny note text in the event log (only a digest identifies it)", async () => {
    const h = boot();
    // Plain words: the log's secret masking would hide a high-entropy token and prove nothing.
    const note = "please leave the staging database alone";
    const res = await h.post(decideBody({ decision: { behavior: "deny", message: note } }));
    expect(res.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, { behavior: "deny", message: note });
    expect(JSON.stringify([...h.engine.storage.events(PROJECT)])).not.toContain(note);
    const snapshot = await h.app.request(`${BASE}/v1/projects/${PROJECT}/snapshot`, {
      headers: sessionHeaders(h.session),
    });
    expect(await snapshot.text()).not.toContain(note);
  });

  it("projects the command and the answered request into the snapshot", async () => {
    const h = boot();
    const body = await json(await h.post(decideBody()));
    const snapshot = (await (
      await h.app.request(`${BASE}/v1/projects/${PROJECT}/snapshot`, {
        headers: sessionHeaders(h.session),
      })
    ).json()) as {
      state: {
        commands: Record<string, { status: string }>;
        requests: Record<string, { state: string }>;
      };
    };
    expect(snapshot.state.commands[body.command?.id ?? ""]?.status).toBe("delivered");
    expect(snapshot.state.requests[REQUEST_ID]?.state).toBe("answered_here");
  });

  it("serves the command by ID to the paired browser, and 404s an unknown ID", async () => {
    const h = boot();
    const posted = await json(await h.post(decideBody()));
    const got = await h.get(posted.command?.id ?? "");
    expect(got.status).toBe(200);
    expect((await json(got)).command).toMatchObject({
      id: posted.command?.id,
      type: "permission.decide",
      requestId: REQUEST_ID,
      status: "delivered",
    });
    const missing = await h.get("no-such-command");
    expect(missing.status).toBe(404);
    expect((await json(missing)).error?.code).toBe("unknown_command");
  });

  it("broadcasts the command events to stream subscribers after they are stored", async () => {
    const h = boot();
    const head = h.engine.storage.head(PROJECT) ?? 0;
    const res = await streamRequest(h.app, PROJECT, sessionHeaders(h.session), `?after=${head}`);
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    await h.post(decideBody());
    const frames = await reader.events(3);
    for (const frame of frames) sseFrameSchema.parse(frame);
    expect(frames.map((f) => (f.data as { type: string }).type)).toEqual([
      "command.requested",
      "request.resolved",
      "command.delivered",
    ]);
    await reader.cancel();
  });
});

describe("permission.decide: idempotency", () => {
  it("returns the same command for a repeated key and asks the bridge once", async () => {
    const h = boot();
    const first = await h.post(decideBody());
    const second = await h.post(decideBody());
    expect(second.status).toBe(first.status);
    const a = await json(first);
    const b = await json(second);
    expect(b.command?.id).toBe(a.command?.id);
    expect(b.command?.status).toBe("delivered");
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(types(commandEvents(h.engine))).toEqual([
      "command.requested",
      "request.resolved",
      "command.delivered",
    ]);
  });

  it("handles two simultaneous submits with one command and one bridge decision", async () => {
    const h = boot();
    const [first, second] = await Promise.all([h.post(decideBody()), h.post(decideBody())]);
    const a = await json(first);
    const b = await json(second);
    expect(a.command?.id).toBeDefined();
    expect(b.command?.id).toBe(a.command?.id);
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(types(commandEvents(h.engine)).filter((t) => t === "command.requested")).toHaveLength(1);
  });

  it("answers 409 idempotency_conflict for the same key with a different body, and sends nothing", async () => {
    const h = boot();
    await h.post(decideBody());
    const res = await h.post(decideBody({ decision: { behavior: "deny" } }));
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("idempotency_conflict");
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(types(commandEvents(h.engine))).toEqual([
      "command.requested",
      "request.resolved",
      "command.delivered",
    ]);
  });

  it("answers 409 idempotency_conflict for the same key and decision with a different deny note, and sends nothing more", async () => {
    const h = boot();
    const first = await json(
      await h.post(decideBody({ decision: { behavior: "deny", message: "note A" } })),
    );
    const res = await h.post(decideBody({ decision: { behavior: "deny", message: "note B" } }));
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("idempotency_conflict");
    // A deny with no note is a different command from one with a note, too.
    const bare = await h.post(decideBody({ decision: { behavior: "deny" } }));
    expect(bare.status).toBe(409);
    expect((await json(bare)).error?.code).toBe("idempotency_conflict");
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, {
      behavior: "deny",
      message: "note A",
    });
    expect(types(commandEvents(h.engine))).toEqual([
      "command.requested",
      "request.resolved",
      "command.delivered",
    ]);
    expect(first.command?.status).toBe("delivered");
  });

  it("returns the same command for the same key, decision and deny note, with one bridge decision", async () => {
    const h = boot();
    const decision = { behavior: "deny", message: "note A" };
    const a = await json(await h.post(decideBody({ decision })));
    const repeat = await h.post(decideBody({ decision: { ...decision } }));
    expect(repeat.status).toBe(200);
    const b = await json(repeat);
    expect(b.command?.id).toBe(a.command?.id);
    expect(b.command?.status).toBe("delivered");
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(types(commandEvents(h.engine))).toEqual([
      "command.requested",
      "request.resolved",
      "command.delivered",
    ]);
  });

  it("fails a second click with a new key as request_not_open, without a second bridge decision", async () => {
    const h = boot();
    await h.post(decideBody());
    const res = await h.post(decideBody({ idempotencyKey: "key-2" }));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe("request_not_open");
    expect(body.command?.status).toBe("failed");
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
    expect(types(commandEvents(h.engine)).slice(3)).toEqual([
      "command.requested",
      "command.failed",
    ]);
  });
});

describe("permission.decide: requests that cannot be answered", () => {
  it("fails an expired hold cleanly: decide is false, command ends expired, 410 request_expired", async () => {
    const h = boot();
    h.bridge.decide.mockReturnValueOnce(false);
    const res = await h.post(decideBody());
    expect(res.status).toBe(410);
    const body = await json(res);
    expect(body.error).toEqual({ code: "request_expired", message: expect.any(String) });
    expect(body.command?.status).toBe("expired");
    expect(types(commandEvents(h.engine))).toEqual(["command.requested", "command.expired"]);
    const got = await json(await h.get(body.command?.id ?? ""));
    expect(got.command?.status).toBe("expired");
  });

  it("treats a request the bridge no longer holds (hold fell through) as expired, never delivered", async () => {
    const h = boot({ holdBridgeRequest: false });
    const res = await h.post(decideBody());
    expect(res.status).toBe(410);
    expect((await json(res)).error?.code).toBe("request_expired");
    expect(types(commandEvents(h.engine))).toEqual(["command.requested", "command.expired"]);
    expect(types(commandEvents(h.engine))).not.toContain("request.resolved");
  });

  it("fails a request already closed in the log as request_not_open and does not ask the bridge", async () => {
    const h = boot({
      seed: [
        requestOpened({}),
        {
          type: "request.expired",
          payload: { requestId: REQUEST_ID },
          sourceId: ENGINE_SOURCE_ID,
        },
      ],
    });
    // The bridge still holds a stale record; the recorded state decides.
    const res = await h.post(decideBody());
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe("request_not_open");
    expect(body.command?.status).toBe("failed");
    expect(h.bridge.decide).not.toHaveBeenCalled();
    const events = commandEvents(h.engine).filter((e) => e.type.startsWith("command."));
    expect(types(events)).toEqual(["command.requested", "command.failed"]);
    expect(events[1]?.payload).toMatchObject({ commandId: body.command?.id });
  });

  it("answers a closed request the bridge no longer holds with request_not_open, not request_expired", async () => {
    // Pins the order of the checks: the recorded state first, then the bridge.
    const h = boot({
      holdBridgeRequest: false,
      seed: [
        requestOpened({}),
        {
          type: "request.expired",
          payload: { requestId: REQUEST_ID },
          sourceId: ENGINE_SOURCE_ID,
        },
      ],
    });
    const res = await h.post(decideBody());
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe("request_not_open");
    expect(body.command?.status).toBe("failed");
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(types(commandEvents(h.engine).filter((e) => e.type.startsWith("command.")))).toEqual([
      "command.requested",
      "command.failed",
    ]);
  });

  it("marks a request the bridge did not hold as unsupported, 422 not_answerable", async () => {
    const h = boot({ seed: [requestOpened({ sourceId: "claude-code" })] });
    const res = await h.post(decideBody());
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error?.code).toBe("not_answerable");
    expect(body.command?.status).toBe("unsupported");
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(types(commandEvents(h.engine))).toEqual(["command.requested", "command.unsupported"]);
  });

  it("answers 404 unknown_request and records nothing for a request the project never had", async () => {
    const h = boot();
    const res = await h.post(decideBody({ requestId: "ghost" }));
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("unknown_request");
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("answers 404 unknown_project and records nothing", async () => {
    const h = boot();
    const res = await h.post(decideBody({ projectId: "ghost" }));
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("unknown_project");
    expect(h.bridge.decide).not.toHaveBeenCalled();
  });
});

describe("history context is rejected (ARCHITECTURE.md 9.2)", () => {
  it("rejects a history-mode command with 400 history_context_rejected and no side effects", async () => {
    const h = boot();
    const res = await h.post(decideBody({ context: { mode: "history" } }));
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("history_context_rejected");
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(h.bridge.lookup).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("accepts an explicit live context", async () => {
    const h = boot();
    const res = await h.post(decideBody({ context: { mode: "live" } }));
    expect(res.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown context mode as a bad request, with no side effects", async () => {
    const h = boot();
    const res = await h.post(decideBody({ context: { mode: "replay" } }));
    expect(res.status).toBe(400);
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("does not let a repeated key bypass the check: the history attempt is not an idempotent replay", async () => {
    const h = boot();
    await h.post(decideBody());
    const res = await h.post(decideBody({ context: { mode: "history" } }));
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("history_context_rejected");
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
  });
});

describe("request validation", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["a missing idempotencyKey", { idempotencyKey: undefined }],
    ["an empty idempotencyKey", { idempotencyKey: "" }],
    ["an unknown decision behavior", { decision: { behavior: "always" } }],
    ["a missing decision", { decision: undefined }],
    ["an unknown command type", { type: "agent.reply" }],
    ["an unexpected extra field", { force: true }],
  ];
  for (const [name, overrides] of bad) {
    it(`answers 400 bad_request for ${name}, with no side effects`, async () => {
      const h = boot();
      const res = await h.post(decideBody(overrides));
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe("bad_request");
      expect(h.bridge.decide).not.toHaveBeenCalled();
      expect(commandEvents(h.engine)).toEqual([]);
    });
  }

  it("answers 413 payload_too_large for a body over 16 KiB, with no side effects", async () => {
    const h = boot();
    const pad = "x".repeat(16 * 1024 + 1);
    const res = await h.app.request(`${BASE}/v1/commands`, {
      method: "POST",
      headers: { ...sessionHeaders(h.session), Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(decideBody({ idempotencyKey: pad })),
    });
    expect(res.status).toBe(413);
    expect((await json(res)).error?.code).toBe("payload_too_large");
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);
  });

  it("answers 400 bad_request for a deny note over MAX_DENY_MESSAGE_CHARS, and accepts one at the limit", async () => {
    const h = boot();
    const over = await h.post(
      decideBody({
        decision: { behavior: "deny", message: "n".repeat(MAX_DENY_MESSAGE_CHARS + 1) },
      }),
    );
    expect(over.status).toBe(400);
    expect((await json(over)).error?.code).toBe("bad_request");
    expect(h.bridge.decide).not.toHaveBeenCalled();
    expect(commandEvents(h.engine)).toEqual([]);

    const atLimit = await h.post(
      decideBody({ decision: { behavior: "deny", message: "n".repeat(MAX_DENY_MESSAGE_CHARS) } }),
    );
    expect(atLimit.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
  });

  it("answers 400 bad_request for a body that is not JSON", async () => {
    const h = boot();
    const res = await h.app.request(`${BASE}/v1/commands`, {
      method: "POST",
      headers: { ...sessionHeaders(h.session), Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(h.bridge.decide).not.toHaveBeenCalled();
  });
});
