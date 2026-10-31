// M2.10 end-to-end check, replayable without a model: real Claude Code sessions recorded by
// `live.ts` (fixtures/*.jsonl, redacted by `redact.ts`) are piped hook by hook through the real
// shim into a real `taskville serve`, and checked through `taskville status --json`, the event
// log, and evidence.db. Push tier, not part of `pnpm check`:
//
//   node --test tests/e2e/claude-code-telemetry/
//
// ARCHITECTURE.md 14, M2 done when: sessions, subagents, and teammates appear in status with
// correct parents within a second; ToolCalls are recorded, with masked evidence; engine downtime
// loses nothing (spool replayed as late, never needs-you).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openEvidenceStore } from "../../../apps/engine/src/evidence/index.ts";
import {
  agentIdOf,
  cli,
  type Engine,
  freePort,
  logEvents,
  loggedToolCalls,
  type Recorded,
  readRecording,
  runShim,
  type SnapshotAgent,
  snapshot,
  startEngine,
  within,
} from "./harness.ts";
import { FAKE_TOKEN, FIXTURES, REDACTED_PROJECT, TOKEN_PLACEHOLDER } from "./redact.ts";

const PROJECT_ID = "e2e";
const homes: string[] = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

async function freshEngine(): Promise<Engine> {
  const home = mkdtempSync(join(tmpdir(), "taskville-e2e-"));
  homes.push(home);
  const engine = await startEngine(home, await freePort());
  const add = await cli([
    "project",
    "add",
    "--name",
    "e2e",
    "--id",
    PROJECT_ID,
    "--root",
    REDACTED_PROJECT,
    "--home",
    home,
    "--url",
    engine.url,
  ]);
  assert.equal(add.code, 0, add.stderr);
  return engine;
}

const fixture = (name: string): Recorded[] => readRecording(join(FIXTURES, `${name}.jsonl`));
const hookName = (r: Recorded) => String(r.input.hook_event_name);
const payloadText = (r: Recorded) =>
  JSON.stringify(r.input).replaceAll(TOKEN_PLACEHOLDER, FAKE_TOKEN);

async function statusAgents(engine: Engine): Promise<SnapshotAgent[]> {
  const res = await cli([
    "status",
    "--project",
    PROJECT_ID,
    "--home",
    engine.home,
    "--url",
    engine.url,
    "--all",
    "--json",
  ]);
  assert.equal(res.code, 0, res.stderr);
  return (JSON.parse(res.stdout) as { agents: SnapshotAgent[] }).agents;
}

/** Hooks that register an agent: a session's start, or a named subagent or teammate's start. */
function registers(r: Recorded): boolean {
  if (hookName(r) === "SessionStart") return true;
  return (
    hookName(r) === "SubagentStart" &&
    typeof r.input.agent_type === "string" &&
    r.input.agent_type !== ""
  );
}

/**
 * Replays hooks in order through the shim. After a hook that registers a new agent, waits for it
 * in `taskville status --json` and records how long that took. `beforeEach` can stop the engine.
 */
interface Target {
  /** The running engine, or undefined while it is down (hooks then spool). */
  current: Engine | undefined;
  home: string;
  url: string;
}

const target = (engine: Engine): Target => ({
  current: engine,
  home: engine.home,
  url: engine.url,
});

async function replay(
  ref: Target,
  hooks: Recorded[],
  beforeHook?: (r: Recorded, i: number) => Promise<void>,
): Promise<Map<string, number>> {
  const appeared = new Map<string, number>();
  for (const [i, r] of hooks.entries()) {
    await beforeHook?.(r, i);
    const running = ref.current;
    const started = performance.now();
    const code = await runShim(payloadText(r), ref.home, ref.url);
    assert.equal(code, 0, `shim exit for hook ${i}`);
    // The shim never blocks the agent: 1 s curl timeout plus the bounded lock wait.
    assert.ok(performance.now() - started < 3000, `shim took too long on hook ${i}`);
    const id = agentIdOf(r.input);
    if (running !== undefined && registers(r) && !appeared.has(id)) {
      const ms = await within(
        1000,
        async () => (await statusAgents(running)).some((a) => a.id === id),
        0,
      );
      assert.notEqual(ms, undefined, `${id} (${hookName(r)}) not in taskville status within 1 s`);
      appeared.set(id, ms ?? 0);
    }
  }
  return appeared;
}

/** Every tool call in the hooks is in the log, with evidence, and the seeded token is masked. */
function checkToolCalls(home: string, hooks: Recorded[]): void {
  const toolHooks = hooks.filter((r) =>
    ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(hookName(r)),
  );
  const ids = new Set(toolHooks.map((r) => String(r.input.tool_use_id)));
  const logged = loggedToolCalls(home, PROJECT_ID);
  for (const id of ids) assert.ok(logged.has(id), `tool call ${id} not in the event log`);
  const store = openEvidenceStore(join(home, "evidence.db"));
  try {
    for (const id of ids) {
      const ev = store.get(PROJECT_ID, id);
      assert.ok(ev !== undefined, `no evidence for tool call ${id}`);
      assert.ok(
        !JSON.stringify(ev).includes(FAKE_TOKEN),
        `evidence for ${id} holds the seeded token`,
      );
      const seeded = toolHooks.some(
        (r) => r.input.tool_use_id === id && payloadText(r).includes(FAKE_TOKEN),
      );
      if (seeded)
        assert.ok(
          ev.input?.masked === true || ev.output?.masked === true,
          `${id} not marked masked`,
        );
    }
  } finally {
    store.close();
  }
}

describe("Claude Code telemetry, end to end (replayed real sessions)", () => {
  it("subagents: session and two subagents with parents, tool calls, tasks, a failure", async () => {
    const hooks = fixture("subagents");
    const engine = await freshEngine();
    const ref = target(engine);
    try {
      const appeared = await replay(ref, hooks);
      const main = agentIdOf(hooks.find((r) => hookName(r) === "SessionStart")?.input ?? {});
      const subs = [
        ...new Set(
          hooks.filter((r) => hookName(r) === "SubagentStart").map((r) => agentIdOf(r.input)),
        ),
      ];
      assert.equal(subs.length, 2);
      assert.equal(appeared.size, 3);
      const agents = await statusAgents(engine);
      assert.equal(agents.find((a) => a.id === main)?.kind, "session");
      for (const id of subs) {
        const sub = agents.find((a) => a.id === id);
        assert.equal(sub?.kind, "subagent");
        assert.equal(sub?.parentAgentId, main);
        assert.ok(sub?.finishedAt !== undefined, `${id} not finished`);
      }
      checkToolCalls(engine.home, hooks);
      const log = logEvents(engine.home, PROJECT_ID);
      assert.ok(log.some((e) => e.type === "tool_call.finished" && e.payload.phase === "failed"));
      const snap = await snapshot(engine, PROJECT_ID);
      const tasks = Object.values(snap.state.tasks);
      assert.ok(
        tasks.some((t) => t.title === "e2e check" && t.status === "completed"),
        JSON.stringify(tasks),
      );
      assert.ok(log.every((e) => e.late !== true));
    } finally {
      await engine.stop();
    }
  });

  it("downtime: engine killed mid-session; the spool replays late, nothing lost, no needs-you", async () => {
    const hooks = fixture("downtime");
    const killAfter = hooks.findIndex(
      (r) =>
        hookName(r) === "PostToolUse" &&
        JSON.stringify(r.input.tool_input ?? {}).includes("echo step1"),
    );
    assert.ok(killAfter > 0, "fixture has the PostToolUse of `echo step1`");
    const first = await freshEngine();
    const ref = target(first);
    const { home, port } = first;
    await replay(ref, hooks, async (_r, i) => {
      if (i === killAfter + 1 && ref.current !== undefined) {
        await ref.current.kill();
        ref.current = undefined;
      }
    });
    const spooled = readdirSync(join(home, "spool")).filter((n) => n.endsWith(".jsonl"));
    assert.ok(spooled.length > 0, "the shim spooled while the engine was down");
    const restarted = await startEngine(home, port);
    try {
      assert.deepEqual(
        readdirSync(join(home, "spool")).filter((n) => !n.startsWith(".")),
        [],
        "spool emptied at start",
      );
      const log = logEvents(home, PROJECT_ID);
      const late = log.filter((e) => e.late === true);
      assert.ok(late.length > 0);
      assert.ok(late.every((e) => e.sourceId === "claude-code"));
      checkToolCalls(home, hooks);
      assert.ok(log.some((e) => e.type === "session.ended" && e.late === true));
      const snap = await snapshot(restarted, PROJECT_ID);
      assert.deepEqual(
        snap.attention.filter((a) => a.level === "needs_you"),
        [],
      );
      const main = agentIdOf(hooks[0]?.input ?? {});
      assert.ok((await statusAgents(restarted)).some((a) => a.id === main));
    } finally {
      await restarted.stop();
    }
  });

  it("team: an in-process teammate appears under its lead within a second", async () => {
    const hooks = fixture("team");
    const teammateHooks = hooks.filter(
      (r) => typeof r.input.agent_id === "string" && r.input.agent_type === "pip",
    );
    assert.ok(teammateHooks.length > 0, "fixture has pip's hooks");
    for (const r of teammateHooks) assert.match(String(r.input.agent_id), /^apip-[0-9a-f]{16}$/);
    const engine = await freshEngine();
    const ref = target(engine);
    try {
      const appeared = await replay(ref, hooks);
      const lead = agentIdOf(hooks.find((r) => hookName(r) === "SessionStart")?.input ?? {});
      const pip = agentIdOf(teammateHooks[0]?.input ?? {});
      assert.ok(appeared.has(pip));
      const agents = await statusAgents(engine);
      const teammate = agents.find((a) => a.id === pip);
      assert.equal(teammate?.kind, "teammate");
      assert.ok(teammate?.teamId !== undefined);
      const snap = await snapshot(engine, PROJECT_ID);
      assert.equal(snap.state.teams[teammate?.teamId ?? ""]?.leadAgentId, lead);
      assert.equal(agents.find((a) => a.id === lead)?.kind, "lead");
      checkToolCalls(engine.home, hooks);
    } finally {
      await engine.stop();
    }
  });

  it("stop failure: a StopFailure becomes a failed turn with the error type", async () => {
    const hooks = fixture("stop-failure");
    assert.ok(hooks.some((r) => hookName(r) === "StopFailure"));
    const engine = await freshEngine();
    const ref = target(engine);
    try {
      await replay(ref, hooks);
      const failed = logEvents(engine.home, PROJECT_ID).filter(
        (e) => e.type === "session.turn_failed",
      );
      assert.equal(failed.length, 1);
      assert.match(JSON.stringify(failed[0]?.payload), /model_not_found/);
    } finally {
      await engine.stop();
    }
  });

  it("elicitation: an MCP elicitation opens a request that is closed by the end of the session", async () => {
    const hooks = fixture("elicitation");
    assert.ok(hooks.some((r) => hookName(r) === "Elicitation"));
    const engine = await freshEngine();
    const ref = target(engine);
    try {
      await replay(ref, hooks);
      const opened = logEvents(engine.home, PROJECT_ID).filter(
        (e) => e.type === "request.opened" && e.payload.kind === "elicitation",
      );
      assert.equal(opened.length, 1);
      const snap = await snapshot(engine, PROJECT_ID);
      assert.ok(Object.values(snap.state.requests).every((r) => r.state !== "open"));
      assert.deepEqual(
        snap.attention.filter((a) => a.level === "needs_you"),
        [],
      );
    } finally {
      await engine.stop();
    }
  });

  it("fixtures are redacted", () => {
    for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith(".jsonl"))) {
      const text = JSON.stringify(readRecording(join(FIXTURES, name)));
      assert.ok(!/\/Users\/(?!dev\b)[^/"]+/.test(text), `${name}: unredacted home path`);
      assert.ok(!text.includes(["gh", "p_"].join("")), `${name}: token-shaped string`);
      assert.ok(existsSync(join(FIXTURES, name)));
    }
  });
});
