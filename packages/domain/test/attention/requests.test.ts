import type { StoredEnvelope, StoredPayload } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { canonicalJson, stateHash } from "../../src/hash/index.ts";
import {
  BRIDGE_SOURCE_ID,
  initialRequestsState,
  type RequestsState,
  reduceRequests,
} from "../../src/reducer/attention/index.ts";
import {
  BRIDGE,
  deepFreeze,
  type Emit,
  ENGINE,
  type EnvelopeFields,
  eventStream,
  reason,
  TELEMETRY,
} from "./envelopes.ts";

const run = (events: StoredEnvelope[], from: RequestsState = initialRequestsState()) =>
  events.reduce(reduceRequests, from);

const LEAD = { agentId: "a1", sessionId: "s1" } as const;

/** `request.opened` for agent a1 in session s1 unless overridden. */
function opened(
  emit: Emit,
  requestId: string,
  payload: Partial<StoredPayload<"request.opened">> = {},
  fields: EnvelopeFields = {},
) {
  return emit(
    "request.opened",
    { requestId, kind: "permission", ...payload },
    { ...LEAD, ...fields },
  );
}

describe("initial state", () => {
  it("has no requests and no commands", () => {
    expect(initialRequestsState()).toEqual({ requests: {}, commands: {} });
  });

  it("names the bridge as the only answerable source", () => {
    expect(BRIDGE_SOURCE_ID).toBe(BRIDGE);
  });
});

describe("request.opened", () => {
  it("projects an open, unanswerable request from telemetry", () => {
    const emit = eventStream();
    const event = opened(emit, "r1", {
      toolName: "Bash",
      inputPreview: "touch a.txt",
      reason: reason("needs permission"),
      expiresAt: "2026-10-30T10:01:31Z",
    });
    expect(run([event]).requests).toEqual({
      r1: {
        id: "r1",
        agentId: "a1",
        sessionId: "s1",
        kind: "permission",
        toolName: "Bash",
        inputPreview: "touch a.txt",
        reason: reason("needs permission"),
        answerable: false,
        openedAt: event.occurredAt,
        expiresAt: "2026-10-30T10:01:31Z",
        state: "open",
        late: false,
        mergedRequestIds: [],
      },
    });
  });

  it("omits absent optional fields instead of storing undefined", () => {
    const emit = eventStream();
    const event = opened(emit, "r1", { kind: "input" }, { sessionId: undefined });
    const request = run([event]).requests.r1;
    expect(request).toBeDefined();
    expect(Object.keys(request ?? {}).sort()).toEqual(
      [
        "agentId",
        "answerable",
        "id",
        "kind",
        "late",
        "mergedRequestIds",
        "openedAt",
        "state",
      ].sort(),
    );
  });

  it("is answerable only when the source is exactly taskville:bridge", () => {
    const emit = eventStream();
    const sources = [
      BRIDGE,
      TELEMETRY,
      ENGINE,
      "taskville:bridge2",
      "Taskville:bridge",
      "taskville:bridge ",
      "adapter:taskville:bridge",
    ];
    const events = sources.map((sourceId, i) =>
      opened(emit, `r${i}`, { toolName: `T${i}` }, { sourceId }),
    );
    const state = run(events);
    expect(sources.map((_, i) => state.requests[`r${i}`]?.answerable)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("keeps the first request when a requestId repeats", () => {
    const emit = eventStream();
    const first = opened(emit, "r1", { toolName: "Bash", inputPreview: "ls" });
    const again = opened(
      emit,
      "r1",
      { toolName: "Bash", inputPreview: "rm -rf x" },
      { sourceId: BRIDGE },
    );
    const state = run([first, again]);
    expect(state.requests.r1).toMatchObject({ inputPreview: "ls", answerable: false });
    expect(Object.keys(state.requests)).toEqual(["r1"]);
  });
});

describe("one prompt, one red state", () => {
  it("merges the Notification that follows a bridge-held PermissionRequest", () => {
    const emit = eventStream();
    const permission = opened(
      emit,
      "bridge-1",
      { toolName: "Bash", inputPreview: "touch exp1.txt" },
      { sourceId: BRIDGE },
    );
    const notification = opened(emit, "notif-1", {
      toolName: "Bash",
      reason: reason("Claude needs your permission"),
    });
    const state = run([permission, notification]);
    expect(Object.keys(state.requests)).toEqual(["bridge-1"]);
    expect(state.requests["bridge-1"]).toMatchObject({
      answerable: true,
      inputPreview: "touch exp1.txt",
      openedAt: permission.occurredAt,
      state: "open",
      mergedRequestIds: ["notif-1"],
    });
  });

  it("merges a duplicate telemetry PermissionRequest and Notification into one unanswerable record", () => {
    const emit = eventStream();
    const permission = opened(emit, "perm-1", { toolName: "Bash", inputPreview: "touch a" });
    const notification = opened(emit, "notif-1", { toolName: "Bash" });
    const state = run([permission, notification]);
    expect(Object.keys(state.requests)).toEqual(["perm-1"]);
    expect(state.requests["perm-1"]).toMatchObject({
      answerable: false,
      mergedRequestIds: ["notif-1"],
    });
  });

  it("lets the bridge's record win when telemetry opened first, so a forged preview is never answerable", () => {
    const emit = eventStream();
    const forged = opened(emit, "tele-1", {
      toolName: "Bash",
      inputPreview: "echo harmless",
      reason: reason("forged"),
    });
    const bridge = opened(
      emit,
      "bridge-1",
      { toolName: "Bash", inputPreview: "rm -rf build", expiresAt: "2026-10-30T10:01:32Z" },
      { sourceId: BRIDGE },
    );
    const state = run([forged, bridge]);
    expect(Object.keys(state.requests)).toEqual(["bridge-1"]);
    expect(state.requests["bridge-1"]).toEqual({
      id: "bridge-1",
      agentId: "a1",
      sessionId: "s1",
      kind: "permission",
      toolName: "Bash",
      inputPreview: "rm -rf build",
      answerable: true,
      openedAt: forged.occurredAt,
      expiresAt: "2026-10-30T10:01:32Z",
      state: "open",
      late: false,
      mergedRequestIds: ["tele-1"],
    });
  });

  it("keeps separate records for different tools, agents, sessions, and kinds", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "r1", { toolName: "Bash" }),
      opened(emit, "r2", { toolName: "Edit" }),
      opened(emit, "r3", { toolName: "Bash" }, { agentId: "sub-1" }),
      opened(emit, "r4", { toolName: "Bash" }, { sessionId: "s2" }),
      opened(emit, "r5", { kind: "elicitation", toolName: "Bash" }),
      opened(emit, "r6", { kind: "elicitation", toolName: "Bash" }),
    ];
    expect(Object.keys(run(events).requests).sort()).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
  });

  it("never merges a request without a session", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "r1", { toolName: "Bash" }, { sessionId: undefined }),
      opened(emit, "r2", { toolName: "Bash" }, { sessionId: undefined }),
    ];
    expect(Object.keys(run(events).requests).sort()).toEqual(["r1", "r2"]);
  });

  it("does not guess a tool: a request without a tool name stays separate from one with a tool", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "bridge-1", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "notif-1", {}),
    ];
    expect(Object.keys(run(events).requests).sort()).toEqual(["bridge-1", "notif-1"]);
  });

  it("merges two requests that both lack a tool name", () => {
    const emit = eventStream();
    const state = run([opened(emit, "n1"), opened(emit, "n2")]);
    expect(Object.keys(state.requests)).toEqual(["n1"]);
    expect(state.requests.n1?.mergedRequestIds).toEqual(["n2"]);
  });

  it("does not merge into a request that is no longer open", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "r1", { toolName: "Bash" }),
      emit("request.expired", { requestId: "r1" }, { sourceId: ENGINE }),
      opened(emit, "r2", { toolName: "Bash" }),
    ];
    const state = run(events);
    expect(state.requests.r1?.state).toBe("expired");
    expect(state.requests.r2).toMatchObject({ state: "open", mergedRequestIds: [] });
  });

  it("keeps two bridge-held requests separate, since each holds its own hook response", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "b1", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "b2", { toolName: "Bash" }, { sourceId: BRIDGE }),
    ];
    const state = run(events);
    expect(Object.keys(state.requests).sort()).toEqual(["b1", "b2"]);
    expect(state.requests.b1?.answerable).toBe(true);
    expect(state.requests.b2?.answerable).toBe(true);
  });

  it("merges into the earliest of several matching records, whatever their key order", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "20", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "3", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "n1", { toolName: "Bash" }),
    ];
    const state = run(events);
    expect(state.requests["20"]?.mergedRequestIds).toEqual(["n1"]);
    expect(state.requests["3"]?.mergedRequestIds).toEqual([]);
  });

  it("treats a merged request ID as already used", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "r1", { toolName: "Bash" }),
      opened(emit, "r2", { toolName: "Bash" }),
      emit("request.expired", { requestId: "r1" }, { sourceId: ENGINE }),
      opened(emit, "r2", { toolName: "Bash" }),
    ];
    const state = run(events);
    expect(Object.keys(state.requests)).toEqual(["r1"]);
    expect(state.requests.r1?.state).toBe("expired");
  });
});

describe("heuristic requests (#120)", () => {
  it("keeps the heuristic marker on the projected request", () => {
    const emit = eventStream();
    const state = run([opened(emit, "r1", { heuristic: true, reason: reason("for: pip") })]);
    expect(state.requests.r1?.heuristic).toBe(true);
    expect(run([opened(eventStream(), "r1")]).requests.r1).not.toHaveProperty("heuristic");
  });

  it("merges the lead's own notification into a worker prompt, keeping the worker's label", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "w1", { heuristic: true, reason: reason("for: pip") }),
      opened(emit, "n1", { reason: reason("Claude needs your permission") }),
    ]);
    expect(Object.keys(state.requests)).toEqual(["w1"]);
    expect(state.requests.w1).toMatchObject({ heuristic: true, mergedRequestIds: ["n1"] });
  });

  it("keeps the worker's label when the lead's notification arrived first (async hooks race)", () => {
    const emit = eventStream();
    const first = opened(emit, "n1", { reason: reason("Claude needs your permission") });
    const state = run([first, opened(emit, "w1", { heuristic: true, reason: reason("for: pip") })]);
    expect(Object.keys(state.requests)).toEqual(["w1"]);
    expect(state.requests.w1).toMatchObject({
      heuristic: true,
      reason: reason("for: pip"),
      openedAt: first.occurredAt,
      mergedRequestIds: ["n1"],
    });
  });

  it("never merges two worker prompts: each guessed teammate keeps its own red state", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "w1", { heuristic: true, reason: reason("for: pip") }),
      opened(emit, "w2", { heuristic: true, reason: reason("for: bo") }),
      opened(emit, "n1", { reason: reason("Claude needs your permission") }),
      opened(emit, "n2", { reason: reason("Claude needs your permission") }),
    ]);
    expect(Object.keys(state.requests).sort()).toEqual(["w1", "w2"]);
    expect(state.requests.w1?.mergedRequestIds).toEqual(["n1", "n2"]);
    expect(state.requests.w2?.reason).toEqual(reason("for: bo"));
  });

  it("lets the bridge's record win over a worker prompt, as over any telemetry", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "w1", { heuristic: true, reason: reason("for: pip") }),
      opened(emit, "b1", {}, { sourceId: BRIDGE }),
    ]);
    expect(state.requests.b1).toMatchObject({ answerable: true, mergedRequestIds: ["w1"] });
    expect(state.requests.b1).not.toHaveProperty("heuristic");
  });
});

describe("late request.opened", () => {
  it("is recorded as expired and late, never open and never answerable", () => {
    const emit = eventStream();
    const state = run([opened(emit, "r1", { toolName: "Bash" }, { late: true })]);
    expect(state.requests.r1).toMatchObject({ state: "expired", late: true, answerable: false });
  });

  it("never merges into an open request", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "r1", { toolName: "Bash" }),
      opened(emit, "r2", { toolName: "Bash" }, { late: true }),
    ];
    const state = run(events);
    expect(state.requests.r1).toMatchObject({ state: "open", mergedRequestIds: [] });
    expect(state.requests.r2).toMatchObject({ state: "expired", late: true });
  });
});

describe("request.resolved and request.expired", () => {
  it("closes an open request with the engine's resolution", () => {
    const emit = eventStream();
    const events = [
      opened(emit, "r1", {}, { sourceId: BRIDGE }),
      opened(emit, "r2", { kind: "input" }),
      emit(
        "request.resolved",
        { requestId: "r1", resolution: "answered_here" },
        { sourceId: ENGINE },
      ),
      emit(
        "request.resolved",
        { requestId: "r2", resolution: "answered_elsewhere" },
        { sourceId: BRIDGE },
      ),
    ];
    const state = run(events);
    expect(state.requests.r1?.state).toBe("answered_here");
    expect(state.requests.r2?.state).toBe("answered_elsewhere");
  });

  it("closes a merged record through any of its request IDs", () => {
    const emit = eventStream();
    const base = [
      opened(emit, "b1", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "n1", { toolName: "Bash" }),
    ];
    const resolved = run([
      ...base,
      emit(
        "request.resolved",
        { requestId: "n1", resolution: "answered_here" },
        { sourceId: ENGINE },
      ),
    ]);
    expect(resolved.requests.b1?.state).toBe("answered_here");
    const expired = run([
      ...base,
      emit("request.expired", { requestId: "n1" }, { sourceId: ENGINE }),
    ]);
    expect(expired.requests.b1?.state).toBe("expired");
  });

  it("expires an open request", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1"),
      emit("request.expired", { requestId: "r1" }, { sourceId: ENGINE }),
    ]);
    expect(state.requests.r1?.state).toBe("expired");
  });

  it("keeps the first closure: a later resolution or expiry changes nothing", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1"),
      emit(
        "request.resolved",
        { requestId: "r1", resolution: "answered_here" },
        { sourceId: ENGINE },
      ),
      emit("request.expired", { requestId: "r1" }, { sourceId: ENGINE }),
      emit(
        "request.resolved",
        { requestId: "r1", resolution: "answered_elsewhere" },
        { sourceId: ENGINE },
      ),
    ]);
    expect(state.requests.r1?.state).toBe("answered_here");
  });

  it("ignores engine-only request events that do not come from a taskville: source", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1"),
      opened(emit, "r2", { kind: "input" }),
      emit(
        "request.resolved",
        { requestId: "r1", resolution: "answered_here" },
        { sourceId: TELEMETRY },
      ),
      emit("request.expired", { requestId: "r2" }, { sourceId: "demo:1" }),
    ]);
    expect(state.requests.r1?.state).toBe("open");
    expect(state.requests.r2?.state).toBe("open");
  });

  it("ignores closures for unknown request IDs", () => {
    const emit = eventStream();
    const before = run([opened(emit, "r1")]);
    const after = run(
      [
        emit(
          "request.resolved",
          { requestId: "zz", resolution: "answered_here" },
          { sourceId: ENGINE },
        ),
        emit("request.expired", { requestId: "zz" }, { sourceId: ENGINE }),
      ],
      before,
    );
    expect(after).toEqual(before);
  });
});

describe("answered_elsewhere on the next same-session event", () => {
  const closers: Array<[string, (emit: Emit, fields: EnvelopeFields) => StoredEnvelope]> = [
    [
      "tool_call.finished",
      (emit, f) => emit("tool_call.finished", { toolCallId: "t1", phase: "succeeded" }, f),
    ],
    [
      "failed tool_call.finished",
      (emit, f) => emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, f),
    ],
    ["session.turn_ended", (emit, f) => emit("session.turn_ended", {}, f)],
    ["session.turn_failed", (emit, f) => emit("session.turn_failed", {}, f)],
    ["session.prompt_submitted", (emit, f) => emit("session.prompt_submitted", {}, f)],
    ["session.ended", (emit, f) => emit("session.ended", {}, f)],
  ];

  it.each(closers)("%s closes every open request in the session", (_, make) => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "r2", { kind: "elicitation" }),
      opened(emit, "other", { toolName: "Bash" }, { sessionId: "s2" }),
      opened(emit, "nosession", { toolName: "Bash" }, { sessionId: undefined }),
      make(emit, LEAD),
    ]);
    expect(state.requests.r1?.state).toBe("answered_elsewhere");
    expect(state.requests.r2?.state).toBe("answered_elsewhere");
    expect(state.requests.other?.state).toBe("open");
    expect(state.requests.nosession?.state).toBe("open");
  });

  it("does not reopen or reclassify a request that is already closed", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1"),
      emit("request.expired", { requestId: "r1" }, { sourceId: ENGINE }),
      emit("session.turn_ended", {}, LEAD),
    ]);
    expect(state.requests.r1?.state).toBe("expired");
  });

  it("is not triggered by events outside the list, or by a tool call with no session", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1", { toolName: "Bash" }),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, LEAD),
      emit("activity.started", { activity: "testing" }, LEAD),
      emit("session.idle_prompt", {}, LEAD),
      emit("session.started", {}, LEAD),
      emit("agent.connected", {}, { agentId: "a1" }),
      opened(emit, "r2", { kind: "input" }),
      emit("tool_call.finished", { toolCallId: "t1", phase: "succeeded" }, { agentId: "a1" }),
    ]);
    expect(state.requests.r1?.state).toBe("open");
    expect(state.requests.r2?.state).toBe("open");
  });

  it("closes as answered_here when a Taskville command for the request already succeeded", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "b1", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "n1", { toolName: "Bash" }),
      opened(emit, "b2", { toolName: "Edit" }, { sourceId: BRIDGE }),
      emit(
        "command.requested",
        {
          commandId: "c1",
          commandType: "permission.decide",
          requestId: "b1",
          payload: { decision: "allow" },
          idempotencyKey: "k1",
        },
        { sourceId: ENGINE },
      ),
      emit("command.delivered", { commandId: "c1" }, { sourceId: ENGINE }),
      emit("command.succeeded", { commandId: "c1" }, { sourceId: ENGINE }),
      emit(
        "command.requested",
        {
          commandId: "c2",
          commandType: "permission.decide",
          requestId: "b2",
          payload: { decision: "deny" },
          idempotencyKey: "k2",
        },
        { sourceId: ENGINE },
      ),
      emit("command.delivered", { commandId: "c2" }, { sourceId: ENGINE }),
      emit("tool_call.finished", { toolCallId: "t1", phase: "succeeded" }, LEAD),
    ]);
    expect(state.requests.b1?.state).toBe("answered_here");
    expect(state.requests.b2?.state).toBe("answered_elsewhere");
  });
  it("does not count a succeeded session.open as an answer", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "b1", { toolName: "Bash" }, { sourceId: BRIDGE }),
      emit(
        "command.requested",
        {
          commandId: "c1",
          commandType: "session.open",
          requestId: "b1",
          payload: {},
          idempotencyKey: "k1",
        },
        { sourceId: ENGINE },
      ),
      emit("command.delivered", { commandId: "c1" }, { sourceId: ENGINE }),
      emit("command.succeeded", { commandId: "c1" }, { sourceId: ENGINE }),
      emit("tool_call.finished", { toolCallId: "t1", phase: "succeeded" }, LEAD),
    ]);
    expect(state.requests.b1?.state).toBe("answered_elsewhere");
  });
});

describe("commands", () => {
  const requested = (
    emit: Emit,
    commandId: string,
    fields: EnvelopeFields = { sourceId: ENGINE },
  ) =>
    emit(
      "command.requested",
      {
        commandId,
        commandType: "permission.decide",
        requestId: "r1",
        payload: { decision: "allow" },
        idempotencyKey: `key-${commandId}`,
      },
      fields,
    );

  it("projects command.requested as a requested command", () => {
    const emit = eventStream();
    const event = requested(emit, "c1");
    expect(run([event]).commands).toEqual({
      c1: {
        id: "c1",
        type: "permission.decide",
        requestId: "r1",
        payload: { decision: "allow" },
        status: "requested",
        idempotencyKey: "key-c1",
        updatedAt: event.occurredAt,
      },
    });
  });

  it("moves requested -> delivered -> succeeded, one event per transition", () => {
    const emit = eventStream();
    const events = [
      requested(emit, "c1"),
      emit("command.delivered", { commandId: "c1" }, { sourceId: ENGINE }),
    ];
    expect(run(events).commands.c1?.status).toBe("delivered");
    const done = emit("command.succeeded", { commandId: "c1" }, { sourceId: ENGINE });
    const state = run([...events, done]);
    expect(state.commands.c1).toMatchObject({ status: "succeeded", updatedAt: done.occurredAt });
  });

  it("records failed with its reason, expired, and unsupported", () => {
    const emit = eventStream();
    const state = run([
      requested(emit, "c1"),
      requested(emit, "c2"),
      requested(emit, "c3"),
      emit("command.delivered", { commandId: "c1" }, { sourceId: ENGINE }),
      emit(
        "command.failed",
        { commandId: "c1", reason: reason("request no longer open") },
        {
          sourceId: ENGINE,
        },
      ),
      emit("command.delivered", { commandId: "c2" }, { sourceId: ENGINE }),
      emit("command.expired", { commandId: "c2" }, { sourceId: ENGINE }),
      emit("command.unsupported", { commandId: "c3" }, { sourceId: ENGINE }),
    ]);
    expect(state.commands.c1).toMatchObject({
      status: "failed",
      reason: reason("request no longer open"),
    });
    expect(state.commands.c2?.status).toBe("expired");
    expect(state.commands.c3?.status).toBe("unsupported");
  });

  it("keeps terminal statuses final, needs delivery before success, and ignores other moves", () => {
    const emit = eventStream();
    const state = run([
      requested(emit, "c1"),
      emit("command.delivered", { commandId: "c1" }, { sourceId: ENGINE }),
      emit("command.succeeded", { commandId: "c1" }, { sourceId: ENGINE }),
      emit("command.failed", { commandId: "c1", reason: reason("late") }, { sourceId: ENGINE }),
      emit("command.delivered", { commandId: "c1" }, { sourceId: ENGINE }),
      requested(emit, "c2"),
      emit("command.delivered", { commandId: "c2" }, { sourceId: ENGINE }),
      emit("command.unsupported", { commandId: "c2" }, { sourceId: ENGINE }),
      emit("command.delivered", { commandId: "c2" }, { sourceId: ENGINE }),
      requested(emit, "c3"),
      emit("command.succeeded", { commandId: "c3" }, { sourceId: ENGINE }),
    ]);
    expect(state.commands.c1?.status).toBe("succeeded");
    expect(state.commands.c1?.reason).toBeUndefined();
    expect(state.commands.c2?.status).toBe("delivered");
    expect(state.commands.c3?.status).toBe("requested");
  });

  it("ignores repeated command.requested, unknown command IDs, and non-engine sources", () => {
    const emit = eventStream();
    const first = requested(emit, "c1");
    const state = run([
      first,
      emit(
        "command.requested",
        {
          commandId: "c1",
          commandType: "session.open",
          requestId: "r9",
          payload: {},
          idempotencyKey: "other",
        },
        { sourceId: ENGINE },
      ),
      emit("command.succeeded", { commandId: "nope" }, { sourceId: ENGINE }),
      requested(emit, "c2", { sourceId: TELEMETRY }),
      emit("command.succeeded", { commandId: "c1" }, { sourceId: TELEMETRY }),
    ]);
    expect(Object.keys(state.commands)).toEqual(["c1"]);
    expect(state.commands.c1).toMatchObject({ type: "permission.decide", status: "requested" });
  });
});

describe("purity and determinism", () => {
  function scenario(emit: Emit): StoredEnvelope[] {
    return [
      opened(emit, "9", { toolName: "Bash" }),
      opened(emit, "b-1", { toolName: "Bash" }, { sourceId: BRIDGE }),
      opened(emit, "10", { toolName: "Bash" }, { agentId: "sub-1" }),
      opened(emit, "x", { kind: "input" }, { sessionId: undefined }),
      emit(
        "command.requested",
        {
          commandId: "c1",
          commandType: "permission.decide",
          requestId: "b-1",
          payload: { decision: "allow", message: "ok" },
          idempotencyKey: "k1",
        },
        { sourceId: ENGINE },
      ),
      emit("command.delivered", { commandId: "c1" }, { sourceId: ENGINE }),
      opened(emit, "11", { toolName: "Bash" }, { agentId: "sub-1" }),
      opened(emit, "late-1", { toolName: "Edit" }, { late: true }),
      emit("session.turn_ended", {}, { agentId: "a1", sessionId: "s9" }),
    ];
  }

  it("never mutates the state or the events it is given", () => {
    const events = deepFreeze(scenario(eventStream()));
    let state = deepFreeze(initialRequestsState());
    for (const event of events) state = deepFreeze(reduceRequests(state, event));
    expect(state.requests["b-1"]?.mergedRequestIds).toEqual(["9"]);
  });

  it("returns the same state object for events it does not handle", () => {
    const emit = eventStream();
    const state = run([opened(emit, "r1")]);
    const unrelated = [
      emit("git.commit", { repo: "r", sha: "abcdef1", parents: [] }),
      emit("agent.connected", {}, { agentId: "a1" }),
      emit("session.turn_ended", {}, { agentId: "a1", sessionId: "s2" }),
    ];
    for (const event of unrelated) expect(reduceRequests(state, event)).toBe(state);
  });

  it("gives the same hash for the same events, and after a canonical JSON round trip", () => {
    const a = run(scenario(eventStream()));
    const b = run(scenario(eventStream()));
    expect(stateHash(1, a)).toBe(stateHash(1, b));

    // A projection restored from storage has canonically sorted keys, so iteration order differs
    // from a live-built one. Applying the same tail must still give the same state.
    const emit = eventStream();
    const events = [
      ...scenario(emit),
      opened(emit, "12", { toolName: "Bash" }),
      opened(emit, "13", { toolName: "Bash" }, { agentId: "sub-1" }),
    ];
    const live = run(events.slice(0, 3));
    const restored = JSON.parse(canonicalJson(live)) as RequestsState;
    const tail = events.slice(3);
    expect(stateHash(1, run(tail, restored))).toBe(stateHash(1, run(tail, live)));
  });
});
