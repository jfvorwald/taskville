import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { bearer, CLI_TOKEN } from "../http/helpers.ts";
import { SseReader } from "../stream/helpers.ts";
import {
  expectQuiet,
  loadRegisterFeedRoutes,
  PARALLEL,
  SPIKE_CWD,
  toolCallFrames,
  toolCallSequences,
  UNMATCHED,
  useHarness,
} from "./helpers.ts";

// M5.01: GET /v1/agents/:id/feed?after=N (ARCHITECTURE.md 2.10 and 10). One `event: toolcall` frame
// per ToolCall state change, `id:` the ingest sequence of the event behind it, so a client resumes
// with `?after=<last id>` (or `Last-Event-ID`, which wins) exactly as on the project stream. A
// PreToolUse makes a `running` frame; its PostToolUse is a second frame for the same toolCallId
// carrying the whole ToolCall again. Driven by the S-2 recordings through the real Claude Code
// mapper, the engine pipeline and the evidence store; nothing is stubbed.
//
// Pinned (the implementer documents these in contracts/http-api.md):
// - `registerFeedRoutes(app, options)` in apps/engine/src/feed/index.ts, options as in helpers.ts.
// - Agent IDs are opaque and URL-encoded. The engine finds the agent's project from its events;
//   `?projectId=` names it when the same agent ID has events in more than one project.
// - Frame data: { toolCallId, agentId, toolName, phase, startedAt?, finishedAt?, durationMs?,
//   summary?, filePaths, evidence: { input, output } } with each evidence part null or
//   { id, status: "stored" | "evicted" }.

const start = useHarness();

async function parallelEngine() {
  const h = await start();
  h.addProject("spike", SPIKE_CWD);
  await h.play(PARALLEL.file);
  return h;
}

describe("the feed module", () => {
  it("exports registerFeedRoutes from apps/engine/src/feed/index.ts", async () => {
    expect(await loadRegisterFeedRoutes()).toBeTypeOf("function");
  });
});

describe("GET /v1/agents/:id/feed: order and pairing", () => {
  it("streams one subagent's ToolCalls in order, a running frame then a finished frame for each", async () => {
    const h = await parallelEngine();
    const reader = await h.openFeed(PARALLEL.a);
    const frames = await toolCallFrames(reader, 6);

    expect(frames.map((f) => f.id)).toEqual(toolCallSequences(h.events("spike"), PARALLEL.a));
    expect(frames.map((f) => [f.data.toolName, f.data.phase])).toEqual([
      ["Read", "running"],
      ["Read", "succeeded"],
      ["Edit", "running"],
      ["Edit", "succeeded"],
      ["Bash", "running"],
      ["Bash", "succeeded"],
    ]);
    expect(frames.map((f) => f.data.toolCallId)).toEqual([
      PARALLEL.aRead,
      PARALLEL.aRead,
      PARALLEL.aEdit,
      PARALLEL.aEdit,
      PARALLEL.aBash,
      PARALLEL.aBash,
    ]);
    for (const frame of frames) expect(frame.data.agentId).toBe(PARALLEL.a);
    await expectQuiet(reader);
    await reader.cancel();
  });

  it("carries times, duration, summary, files, and evidence references on the right frames", async () => {
    const h = await parallelEngine();
    const reader = await h.openFeed(PARALLEL.a);
    const frames = await toolCallFrames(reader, 6);
    await reader.cancel();
    const [, , editRunning, editDone, bashRunning, bashDone] = frames.map((f) => f.data);

    // Running: what the PreToolUse reported, no outcome invented.
    expect(editRunning?.filePaths).toEqual([`${SPIKE_CWD}/notes.txt`]);
    expect(editRunning?.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(editRunning).not.toHaveProperty("finishedAt");
    expect(editRunning).not.toHaveProperty("durationMs");
    expect(editRunning?.evidence.input).toEqual({ id: expect.any(String), status: "stored" });
    expect(editRunning?.evidence.output).toBeNull();

    // Finished: the same ToolCall, updated.
    expect(editDone?.startedAt).toBe(editRunning?.startedAt);
    expect(editDone?.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(Date.parse(editDone?.finishedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(editDone?.startedAt ?? ""),
    );
    expect(editDone?.durationMs).toBe(5);
    expect(editDone?.filePaths).toEqual([`${SPIKE_CWD}/notes.txt`]);
    expect(editDone?.evidence.input?.id).toBe(editRunning?.evidence.input?.id);
    expect(editDone?.evidence.output).toEqual({ id: expect.any(String), status: "stored" });
    expect(editDone?.evidence.output?.id).not.toBe(editDone?.evidence.input?.id);

    expect(bashRunning?.summary).toBe("Count lines in notes.txt");
    expect(bashDone?.summary).toBe("Count lines in notes.txt");
    expect(bashDone?.durationMs).toBe(33);
  });

  it("shows a failed ToolCall as failed, with the failure summary", async () => {
    const h = await parallelEngine();
    const reader = await h.openFeed(PARALLEL.lead);
    const frames = await toolCallFrames(reader, 6);
    await reader.cancel();
    // The lead fired two Agent calls (launching A and B) and then `cat missing.txt`.
    expect(frames.map((f) => [f.data.toolName, f.data.phase])).toEqual([
      ["Agent", "running"],
      ["Agent", "succeeded"],
      ["Agent", "running"],
      ["Agent", "succeeded"],
      ["Bash", "running"],
      ["Bash", "failed"],
    ]);
    const failed = frames[5]?.data;
    expect(failed?.toolCallId).toBe(PARALLEL.leadFailingBash);
    expect(failed?.summary).toBe("Exit code 1");
    expect(failed?.durationMs).toBe(26);
  });

  it("streams only the requested agent's calls, never its parent's or sibling's", async () => {
    const h = await parallelEngine();
    const reader = await h.openFeed(PARALLEL.b);
    const frames = await toolCallFrames(reader, 4);
    expect(frames.map((f) => f.data.toolName)).toEqual(["Write", "Write", "Bash", "Bash"]);
    for (const frame of frames) expect(frame.data.agentId).toBe(PARALLEL.b);
    await expectQuiet(reader);
    await reader.cancel();
  });

  it("leaves a ToolCall whose PostToolUse never arrives running, and never invents an end", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await h.play(UNMATCHED.file);
    const reader = await h.openFeed(UNMATCHED.agent);
    const [frame] = await toolCallFrames(reader, 1);
    expect(frame?.data.toolCallId).toBe(UNMATCHED.toolCallId);
    expect(frame?.data.toolName).toBe("Bash");
    expect(frame?.data.phase).toBe("running");
    expect(frame?.data).not.toHaveProperty("finishedAt");
    expect(frame?.data).not.toHaveProperty("durationMs");
    expect(frame?.data.evidence.output).toBeNull();
    await expectQuiet(reader);
    await reader.cancel();
  });
});

describe("GET /v1/agents/:id/feed: backlog, then live", () => {
  it("sends the backlog first and then each new frame as it is recorded, with no gap or duplicate", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    const readDone = (events: StoredEnvelope[]) =>
      events.some(
        (e) =>
          e.type === "tool_call.finished" &&
          e.agentId === PARALLEL.a &&
          (e.payload as { toolCallId?: string }).toolCallId === PARALLEL.aRead,
      );
    const next = await h.play(PARALLEL.file, { stopAfter: readDone });

    const reader = await h.openFeed(PARALLEL.a);
    const backlog = await toolCallFrames(reader, 2);
    expect(backlog.map((f) => f.data.phase)).toEqual(["running", "succeeded"]);
    await expectQuiet(reader);

    await h.play(PARALLEL.file, { from: next });
    const live = await toolCallFrames(reader, 4);
    await reader.cancel();

    const ids = [...backlog, ...live].map((f) => f.id);
    expect(ids).toEqual(toolCallSequences(h.events("spike"), PARALLEL.a));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("turns a live PreToolUse into a running frame and its PostToolUse into an update of the same ToolCall", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    const common = {
      session_id: "5c1d0a7e-2b34-4c55-9a60-1f2e3d4c5b6a",
      cwd: SPIKE_CWD,
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "echo live", description: "Say live" },
      tool_use_id: "toolu_live000000000000000001",
    };
    await h.hook({ ...common, hook_event_name: "SessionStart", source: "startup" }, "live#0");
    await h.hook({ ...common, hook_event_name: "PreToolUse" }, "live#1");
    const agent = "claude-code:5c1d0a7e-2b34-4c55-9a60-1f2e3d4c5b6a";

    const reader = await h.openFeed(agent);
    const [pending] = await toolCallFrames(reader, 1);
    expect(pending?.data.phase).toBe("running");
    await expectQuiet(reader);

    await h.hook(
      {
        ...common,
        hook_event_name: "PostToolUse",
        tool_response: { stdout: "live", stderr: "", interrupted: false },
        duration_ms: 12,
      },
      "live#2",
    );
    const [done] = await toolCallFrames(reader, 1);
    await reader.cancel();
    expect(done?.data.toolCallId).toBe(pending?.data.toolCallId);
    expect(done?.data.phase).toBe("succeeded");
    expect(done?.data.durationMs).toBe(12);
    expect(done?.id).toBeGreaterThan(pending?.id ?? Number.POSITIVE_INFINITY);
    expect(done?.data.evidence.output?.status).toBe("stored");
    // The body is readable as soon as the frame names it.
    const body = await h.evidenceBody(done?.data.evidence.output?.id ?? "");
    expect(body.status).toBe(200);
  });
});

describe("GET /v1/agents/:id/feed: resume", () => {
  it("resumes after any frame it already delivered with exactly the frames that follow", async () => {
    const h = await parallelEngine();
    const first = await h.openFeed(PARALLEL.a);
    const all = await toolCallFrames(first, 6);
    await first.cancel();

    for (const cut of [0, 1, 3, 4]) {
      const reader = await h.openFeed(PARALLEL.a, `?after=${all[cut]?.id}`);
      const resumed = await toolCallFrames(reader, all.length - cut - 1);
      expect(resumed).toEqual(all.slice(cut + 1));
      await expectQuiet(reader);
      await reader.cancel();
    }
  });

  it("prefers Last-Event-ID over ?after=, like the project stream", async () => {
    const h = await parallelEngine();
    const first = await h.openFeed(PARALLEL.a);
    const all = await toolCallFrames(first, 6);
    await first.cancel();

    const res = await h.feed(PARALLEL.a, `?after=${all[0]?.id}`, {
      ...bearer(CLI_TOKEN),
      "Last-Event-ID": String(all[3]?.id),
    });
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    expect(await toolCallFrames(reader, 2)).toEqual(all.slice(4));
    await reader.cancel();
  });

  it("picks up exactly where a dropped live connection stopped", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    const midway = (events: StoredEnvelope[]) =>
      events.some((e) => e.type === "tool_call.started" && e.agentId === PARALLEL.a);
    const next = await h.play(PARALLEL.file, { stopAfter: midway });

    const first = await h.openFeed(PARALLEL.a);
    const [seen] = await toolCallFrames(first, 1);
    await first.cancel();

    await h.play(PARALLEL.file, { from: next });
    const second = await h.openFeed(PARALLEL.a, `?after=${seen?.id}`);
    const rest = await toolCallFrames(second, 5);
    await second.cancel();

    const ids = [seen, ...rest].map((f) => f?.id);
    expect(ids).toEqual(toolCallSequences(h.events("spike"), PARALLEL.a));
  });

  it("sends nothing old when the cursor is at the project head, then the next frame live", async () => {
    const h = await parallelEngine();
    const head = h.engine.storage.head("spike") ?? 0;
    const reader = await h.openFeed(PARALLEL.a, `?after=${head}`);
    await expectQuiet(reader);

    await h.hook(
      {
        session_id: PARALLEL.session,
        cwd: SPIKE_CWD,
        agent_id: "afdf84bea07a9064c",
        agent_type: "general-purpose",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo more", description: "One more call" },
        tool_use_id: "toolu_after_head00000000001",
      },
      "after-head",
    );
    const [frame] = await toolCallFrames(reader, 1);
    await reader.cancel();
    expect(frame?.id).toBeGreaterThan(head);
    expect(frame?.data.toolCallId).toBe("toolu_after_head00000000001");
    expect(frame?.data.phase).toBe("running");
  });

  it("answers an unservable cursor with a resnapshot frame, then ends the stream", async () => {
    const h = await parallelEngine();
    const head = h.engine.storage.head("spike") ?? 0;
    const res = await h.feed(PARALLEL.a, `?after=${head + 1000}`);
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    expect(await reader.next()).toEqual({
      event: "resnapshot",
      data: { reason: "cursor_ahead_of_head" },
    });
    expect(await reader.next()).toBeNull();
  });

  it("refuses a malformed cursor with 400 bad_request", async () => {
    const h = await parallelEngine();
    for (const after of ["abc", "-1", "1.5", "01"]) {
      const res = await h.feed(PARALLEL.a, `?after=${after}`);
      expect(res.status, after).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "bad_request", message: expect.any(String) },
      });
    }
  });
});
