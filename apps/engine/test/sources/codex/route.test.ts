import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectState } from "@taskville/domain/reducer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_HOOKS_PATH,
  CODEX_SOURCE_ID,
  registerCodexRoutes,
  replayCodexSpool,
} from "../../../src/sources/codex/index.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  makeApp,
  ORIGIN,
  postJson,
  sessionHeaders,
} from "../../http/helpers.ts";
import {
  FIXTURE_CWD,
  fixtureHooks,
  hookId,
  makeCodexSource,
  PROJECT,
  useProjects,
} from "./helpers.ts";

// A1.02 (#507): `POST /v1/sources/codex/hooks`, the Codex twin of the Claude Code hooks route.
// It maps raw hooks through `mapCodexHook`, keeping what the mapper context needs (known
// sessions, open tool calls per session and turn) in the engine, and ingests through the M1
// pipeline with the same idempotency (the shim's sourceEventId) and spool replay.

const db = useProjects([{ id: PROJECT, roots: [FIXTURE_CWD] }]);
const URL = `http://127.0.0.1:4807${CODEX_HOOKS_PATH}`;

interface Reply {
  projectId: string;
  results: { status: string; sourceEventId: string }[];
  heads: Record<string, number>;
  ignored?: true;
  error: { code: string };
}

function setup() {
  const { app, pairing } = makeApp();
  const source = makeCodexSource(db());
  registerCodexRoutes(app, source);
  return { app, pairing, source };
}

type App = ReturnType<typeof setup>["app"];

async function post(app: App, label: string, payload: Record<string, unknown>) {
  const res = await app.request(
    URL,
    postJson({ sourceEventId: hookId(label), payload }, bearer(CLI_TOKEN)),
  );
  return { res, body: (await res.json()) as Reply };
}

async function replay(app: App, name: string) {
  const replies: Reply[] = [];
  for (const [i, payload] of fixtureHooks(name).entries()) {
    const { res, body } = await post(app, `${name}#${i}`, payload);
    expect(res.status, `${name} line ${i}`).toBe(200);
    replies.push(body);
  }
  return replies;
}

const events = () => [...db().events(PROJECT, 0)];
const state = () => db().projection<ProjectState>(PROJECT)?.state as ProjectState;

/** A hand-written Codex hook in the recorded shape. */
function hook(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "01a1bd20-aaaa-7000-8000-000000000001",
    transcript_path: "~/.codex/sessions/rollout.jsonl",
    cwd: FIXTURE_CWD,
    hook_event_name: event,
    model: "gpt-6-luna",
    permission_mode: "default",
    ...extra,
  };
}
const SESSION = "01a1bd20-aaaa-7000-8000-000000000001";
const TURN_A = "01a1bd20-aaaa-7000-8000-00000000000a";
const TURN_B = "01a1bd20-aaaa-7000-8000-00000000000b";
const CHILD = "01a1bd20-aaaa-7000-8000-0000000000c1";

const pre = (id: string, turn: string, extra: Record<string, unknown> = {}) =>
  hook("PreToolUse", {
    turn_id: turn,
    tool_name: "Bash",
    tool_input: { command: `echo ${id}` },
    tool_use_id: id,
    ...extra,
  });

describe("POST /v1/sources/codex/hooks - credentials", () => {
  it("accepts the CLI token and records events with sourceId codex", async () => {
    const { app } = setup();
    const { res, body } = await post(app, "start", hook("SessionStart", { source: "startup" }));
    expect(res.status).toBe(200);
    expect(body.projectId).toBe(PROJECT);
    expect(body.results.every((r) => r.status === "accepted")).toBe(true);
    expect(events().length).toBeGreaterThan(0);
    expect(events().every((e) => e.sourceId === CODEX_SOURCE_ID && e.sourceId === "codex")).toBe(
      true,
    );
  });

  it("refuses a browser session and the bridge token like the Claude Code route", async () => {
    const { app, pairing } = setup();
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    for (const headers of [{ ...sessionHeaders(session), Origin: ORIGIN }, bearer(BRIDGE_TOKEN)]) {
      const res = await app.request(
        URL,
        postJson({ sourceEventId: hookId("deny"), payload: hook("SessionStart") }, headers),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as Reply).error.code).toBe("credential_not_allowed");
    }
    expect(events()).toHaveLength(0);
  });

  it("refuses no credential and a body that is not { sourceEventId, payload }", async () => {
    const { app } = setup();
    const body = { sourceEventId: hookId("anon"), payload: hook("SessionStart") };
    const anonymous = await app.request(URL, postJson(body, { Host: "127.0.0.1:4807" }));
    expect(anonymous.status).toBe(401);
    for (const bad of [
      { payload: hook("SessionStart") },
      { sourceEventId: "not-a-uuid", payload: hook("SessionStart") },
      { sourceEventId: hookId("x"), payload: [] },
    ]) {
      const res = await app.request(URL, postJson(bad, bearer(CLI_TOKEN)));
      expect(res.status).toBe(400);
    }
    expect(events()).toHaveLength(0);
  });
});

describe("fixtures/codex through the route", () => {
  it("tui-hooks: session agent, a subagent, returned tool calls, an interrupted turn", async () => {
    const { app } = setup();
    const replies = await replay(app, "tui-hooks");
    for (const reply of replies) for (const r of reply.results) expect(r.status).toBe("accepted");

    const sessionId = String(fixtureHooks("tui-hooks")[0]?.session_id);
    const childId = String(
      fixtureHooks("tui-hooks").find((h) => h.hook_event_name === "SubagentStart")?.agent_id,
    );
    const agents = state().agents;
    expect(agents[`codex:${sessionId}`]).toMatchObject({
      sourceId: "codex",
      kind: "session",
      registered: true,
    });
    expect(agents[`codex:${sessionId}:${childId}`]).toMatchObject({
      kind: "subagent",
      parentAgentId: `codex:${sessionId}`,
    });
    expect(agents[`codex:${sessionId}:${childId}`]?.finishedAt).toBeDefined();

    const started = events().filter((e) => e.type === "tool_call.started");
    const finished = events().filter((e) => e.type === "tool_call.finished");
    expect(started).toHaveLength(6);
    // Every call finished, the denied one closed by the Interrupt, none claimed as succeeded.
    expect(finished).toHaveLength(started.length);
    expect(finished.every((e) => (e.payload as { phase: string }).phase === "returned")).toBe(true);
    expect(JSON.stringify(events())).not.toContain("succeeded");
    expect(Object.values(state().toolCalls).filter((c) => c.phase === "running")).toEqual([]);

    const failed = events().filter((e) => e.type === "session.turn_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ reason: "interrupted" });
    expect(events().filter((e) => e.type === "session.ended")).toHaveLength(1);
  });

  it("exec-hooks: a session with returned calls and no subagent", async () => {
    const { app } = setup();
    await replay(app, "exec-hooks");
    const finished = events().filter((e) => e.type === "tool_call.finished");
    expect(finished).toHaveLength(4);
    expect(finished.every((e) => (e.payload as { phase: string }).phase === "returned")).toBe(true);
    expect(JSON.stringify(events())).not.toContain("succeeded");
    expect(Object.values(state().agents).filter((a) => a.kind === "subagent")).toEqual([]);
  });

  it("is idempotent: replaying the same sourceEventIds adds nothing", async () => {
    const { app } = setup();
    await replay(app, "tui-hooks");
    const head = db().head(PROJECT);
    const count = events().length;
    const again = await replay(app, "tui-hooks");
    for (const reply of again) {
      for (const r of reply.results) expect(r.status, JSON.stringify(r)).toBe("duplicate");
    }
    expect(db().head(PROJECT)).toBe(head);
    expect(events()).toHaveLength(count);
  });
});

describe("open tool calls per session and turn", () => {
  async function seed(app: App) {
    await post(app, "s", hook("SessionStart", { source: "startup" }));
    await post(app, "a1", pre("call-a1", TURN_A));
    await post(app, "a2", pre("call-a2", TURN_A));
    await post(app, "a3", pre("call-a3", TURN_A, { agent_id: CHILD, agent_type: "default" }));
    await post(app, "b1", pre("call-b1", TURN_B));
  }
  const phase = (id: string) => state().toolCalls[id]?.phase;

  it("an Interrupt closes the open calls of its turn, subagent calls included, and no others", async () => {
    const { app } = setup();
    await seed(app);
    expect([phase("call-a1"), phase("call-a2"), phase("call-a3"), phase("call-b1")]).toEqual([
      "running",
      "running",
      "running",
      "running",
    ]);
    const { body } = await post(app, "int", hook("Interrupt", { turn_id: TURN_A }));
    expect(body.results.every((r) => r.status === "accepted")).toBe(true);
    expect([phase("call-a1"), phase("call-a2"), phase("call-a3"), phase("call-b1")]).toEqual([
      "returned",
      "returned",
      "returned",
      "running",
    ]);
    // The subagent's call is closed under the subagent, not the main agent.
    const closed = events().find(
      (e) =>
        e.type === "tool_call.finished" &&
        (e.payload as { toolCallId: string }).toolCallId === "call-a3",
    );
    expect(closed?.agentId).toBe(`codex:${SESSION}:${CHILD}`);
  });

  it("a call that finished is no longer open when the Interrupt arrives", async () => {
    const { app } = setup();
    await seed(app);
    await post(
      app,
      "post-a1",
      hook("PostToolUse", {
        turn_id: TURN_A,
        tool_name: "Bash",
        tool_input: { command: "echo call-a1" },
        tool_response: "",
        tool_use_id: "call-a1",
      }),
    );
    await post(app, "int", hook("Interrupt", { turn_id: TURN_A }));
    const finishes = events().filter(
      (e) =>
        e.type === "tool_call.finished" &&
        (e.payload as { toolCallId: string }).toolCallId === "call-a1",
    );
    expect(finishes).toHaveLength(1);
  });

  it("a retried Interrupt is a duplicate, never a conflict, and adds no events", async () => {
    const { app } = setup();
    await seed(app);
    await post(app, "int", hook("Interrupt", { turn_id: TURN_A }));
    const head = db().head(PROJECT);
    const { body } = await post(app, "int", hook("Interrupt", { turn_id: TURN_A }));
    expect(body.results.map((r) => r.status).filter((s) => s !== "duplicate")).toEqual([]);
    expect(db().head(PROJECT)).toBe(head);
  });

  it("tracks sessions apart: another session's Interrupt for the same turn id closes nothing here", async () => {
    const { app } = setup();
    await seed(app);
    await post(
      app,
      "other",
      hook("Interrupt", { session_id: "01a1bd20-bbbb-7000-8000-000000000002", turn_id: TURN_A }),
    );
    expect(phase("call-a1")).toBe("running");
  });

  it("ignores a SessionEnd for a session it never saw start, and records one it did", async () => {
    const { app } = setup();
    const lone = await post(app, "end-1", hook("SessionEnd", { reason: "other" }));
    expect(lone.res.status).toBe(200);
    expect(lone.body.ignored).toBe(true);
    expect(events().filter((e) => e.type === "session.ended")).toEqual([]);

    await post(app, "start", hook("SessionStart", { source: "startup" }));
    await post(app, "end-2", hook("SessionEnd", { reason: "other" }));
    expect(events().filter((e) => e.type === "session.ended")).toHaveLength(1);
  });
});

describe("spool replay (codex.jsonl)", () => {
  let spoolDir = "";
  beforeEach(() => {
    spoolDir = mkdtempSync(join(tmpdir(), "taskville-codex-spool-"));
    mkdirSync(spoolDir, { recursive: true });
  });
  afterEach(() => rmSync(spoolDir, { recursive: true, force: true }));

  const SPOOLED_AT = "2026-10-31T09:15:00Z";
  const spoolLine = (id: string, payload: Record<string, unknown>) =>
    `${JSON.stringify({ payload, sourceEventId: id, spooledAt: SPOOLED_AT })}\n`;

  it("replays codex.jsonl late, dated at spooledAt, removes it, and leaves claude-code.jsonl alone", async () => {
    const id = hookId("spooled-start");
    writeFileSync(
      join(spoolDir, "codex.jsonl"),
      spoolLine(id, hook("SessionStart", { source: "startup" })),
      { mode: 0o600 },
    );
    const other = join(spoolDir, "claude-code.jsonl");
    writeFileSync(other, "keep me\n", { mode: 0o600 });

    const report = await replayCodexSpool({ spoolDir, source: makeCodexSource(db()) });
    expect(report).toMatchObject({ mainFile: "claimed", hooks: 1, failed: false });
    expect(report.accepted).toBeGreaterThan(0);
    const recorded = events().filter((e) => e.sourceId === "codex");
    expect(recorded).toHaveLength(report.accepted);
    for (const event of recorded) {
      expect(event.late).toBe(true);
      expect(event.occurredAt).toBe(SPOOLED_AT);
      expect(event.sourceEventId.startsWith(id)).toBe(true);
    }
    expect(readdirSync(spoolDir).sort()).toEqual(["claude-code.jsonl"]);
  });

  it("is idempotent against a hook that already reached the route live", async () => {
    const { app, source } = setup();
    const payload = hook("SessionStart", { source: "startup" });
    const live = await post(app, "live-start", payload);
    const head = db().head(PROJECT);
    writeFileSync(join(spoolDir, "codex.jsonl"), spoolLine(hookId("live-start"), payload), {
      mode: 0o600,
    });
    const report = await replayCodexSpool({ spoolDir, source });
    expect(report).toMatchObject({ accepted: 0, conflict: 0, duplicate: live.body.results.length });
    expect(db().head(PROJECT)).toBe(head);
    expect(events().every((e) => e.late === false)).toBe(true);
  });
});
