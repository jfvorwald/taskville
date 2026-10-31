// The seeded six-agent scenario (spec 001 US3, FR-013; ARCHITECTURE.md 2 and 2.9).
//
// Six agents work tasks through every area: Ada dispatches (Dispatch), Brook and Cyd implement
// (Workshop), Dee tests (Test Lab), Eli reviews (Review) and sends security-reviewer subagents
// (Security), and Fay documents and researches (Archives). Tasks are handed off implementer ->
// tester -> reviewer, completed, and merged. Brook sends explorer subagents, and Ada now and
// then leads a small in-process team whose teammate messages her (SendMessage). Shapes follow
// spike S-2 as in fixtures/events/crew.jsonl: a subagent registers without a parent and is linked
// once the parent's Agent tool call returns; a teammate shares its lead's session.
//
// Needs you. Demo events come from a `demo:<seed>` source with `demo` provenance, which the
// batch route accepts for `request.opened` (protocol `producerPolicyViolation`). Only the
// engine's permission bridge (`taskville:bridge`) can make a request answerable, so every demo
// request is telemetry-only: the agent turns red, the city offers "Open session" alone, and the
// request closes as `answered_elsewhere` when the agent's own tool result arrives, as when a
// prompt is answered in the agent's terminal. Nothing else happens on that session meanwhile,
// so the next same-session event is exactly that tool result.
//
// Every visible change is one step; steps are `changeMinMs` to `changeMaxMs` apart on the
// virtual clock, and all choices come from one mulberry32 stream, so a seed and pace always give
// the same steps. Agents are generators that yield one step's events at a time, or null when
// they have nothing to do.

import type { InputEventWire } from "@taskville/protocol";
import type { Pace } from "./pace.ts";
import { type Rng, seededRng } from "./rng.ts";
import { DEMO_EPOCH_MS, isoFromMs } from "./time.ts";

export type DemoEvent = InputEventWire;

export interface DemoStep {
  /** Simulated milliseconds since the start of the run. */
  readonly atMs: number;
  readonly events: readonly DemoEvent[];
}

export interface DemoOptions {
  readonly seed: number;
  readonly pace: Pace;
  readonly projectId?: string;
  /** Epoch milliseconds of simulated time zero; defaults to DEMO_EPOCH_MS for offline runs. */
  readonly startAtMs?: number;
}

const MIN = 60_000;
const REPO = "taskville-demo";
const WORKDIR = "/workspace/taskville-demo";

const TITLES = [
  "Add login form",
  "Fix flaky clock test",
  "Paginate the event list",
  "Cache project snapshots",
  "Add dark theme tokens",
  "Validate config on load",
  "Speed up the replay loop",
  "Show waiting agents in status",
  "Retry failed batch posts",
  "Add a health route check",
  "Trim long tool summaries",
  "Index events by session",
];
const FILES = [
  "src/app.ts",
  "src/routes.ts",
  "src/store.ts",
  "src/view.ts",
  "src/config.ts",
  "test/app.test.ts",
];
const COMMANDS = [
  "pnpm test",
  "pnpm lint",
  "pnpm build",
  "git status",
  "pnpm install",
  "node scripts/seed.ts",
];
const FAILURES = ["API error: overloaded, will retry", "Turn stopped: tool output too large"];
const RESEARCH = [
  "Read docs/ROADMAP.md",
  "Search issues for flaky tests",
  "Read ARCHITECTURE.md",
  "Compare cache strategies",
];
const MATES = ["scout", "tester", "scribe"];
/** Tasks in flight at once, so work flows through the city instead of piling up at one desk. */
const MAX_OPEN_TASKS = 4;

type Beat = DemoEvent[];
type Script = Generator<Beat | null, void, void>;

interface Agent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly sessionId: string;
  readonly topLevel: boolean;
  readonly queue: Task[];
  activity: string;
  waiting: boolean;
  busy: boolean;
  script?: Script;
  /** Needs-you hold: the closing tool result is emitted once the virtual clock reaches `until`. */
  hold?: { until: number; close: () => Beat } | undefined;
}

interface Task {
  readonly id: string;
  readonly title: string;
  readonly implementer: Agent;
  reworked: boolean;
}

/** Index chosen by `weights` for a uniform draw `u` in [0, 1). */
function weightedIndex(weights: readonly number[], u: number): number {
  let roll = u * weights.reduce((sum, w) => sum + w, 0);
  for (const [index, weight] of weights.entries()) {
    roll -= weight;
    if (roll < 0) return index;
  }
  return weights.length - 1;
}

/** Steps of the scenario, endless unless `durationMs` is given (steps with `atMs < durationMs`). */
export function* demoSteps(options: DemoOptions & { durationMs?: number }): Generator<DemoStep> {
  const { seed, pace } = options;
  const projectId = options.projectId ?? "demo";
  const startAtMs = options.startAtMs ?? DEMO_EPOCH_MS;
  const rng: Rng = seededRng(seed);
  const prefix = `d${seed}`;
  const run = `r${Math.floor(startAtMs / 1000).toString(36)}`;
  let at = 0;
  let sequence = 0;
  let counter = 0;
  const nextId = (kind: string) => `${prefix}-${run}-${kind}${++counter}`;

  const ev = (
    type: string,
    payload: Record<string, unknown>,
    ids: { agent?: Agent; session?: boolean; task?: string } = {},
  ): DemoEvent => {
    sequence += 1;
    const event: Record<string, unknown> = {
      schemaVersion: 1,
      projectId,
      sourceId: `demo:${seed}`,
      sourceEventId: `${run}-e${sequence}`,
      sourceSequence: sequence,
      occurredAt: isoFromMs(startAtMs + at),
      type,
    };
    if (ids.agent !== undefined) event.agentId = ids.agent.id;
    if (ids.agent !== undefined && ids.session !== false) event.sessionId = ids.agent.sessionId;
    if (ids.task !== undefined) event.taskId = ids.task;
    event.payload = payload;
    event.provenance = "demo";
    return event as DemoEvent;
  };

  const agent = (key: string, name: string, role: string, sessionId?: string): Agent => ({
    id: `${prefix}-${key}`,
    name,
    role,
    sessionId: sessionId ?? `${prefix}-${run}-sess-${key}`,
    topLevel: sessionId === undefined,
    queue: [],
    activity: "idle",
    waiting: false,
    busy: false,
  });

  const ada = agent("ada", "Ada", "lead");
  const brook = agent("brook", "Brook", "implementer");
  const cyd = agent("cyd", "Cyd", "implementer");
  const dee = agent("dee", "Dee", "tester");
  const eli = agent("eli", "Eli", "reviewer");
  const fay = agent("fay", "Fay", "documenter");
  const team = [ada, brook, cyd, dee, eli, fay];
  const blockedSessions = new Set<string>();
  let mergeHead = rng.hex(40);
  let taskCount = 0;
  let openTasks = 0;
  let reviewCount = 0;
  let nextCrewAt = rng.int(4, 8) * MIN;
  let nextNeedsYouAt = Math.round(pace.needsYouMs * (0.4 + 0.5 * rng.next()));

  // Building blocks, each yielding one beat per visible change.

  const registered = (a: Agent, kind: string, extra: Record<string, unknown> = {}) =>
    ev(
      "agent.registered",
      {
        sourceAgentId: a.id.slice(prefix.length + 1),
        displayName: a.name,
        role: a.role,
        kind,
        ...extra,
      },
      { agent: a },
    );

  const activity = (a: Agent, name: string, task?: string): Beat => {
    if (a.activity === name) return [];
    a.activity = name;
    return [
      ev(
        "activity.started",
        { activity: name },
        task === undefined ? { agent: a } : { agent: a, task },
      ),
    ];
  };

  function* arrive(a: Agent): Script {
    yield [
      registered(a, "session"),
      ev("session.started", { workingDirectory: WORKDIR }, { agent: a }),
      ev("agent.connected", {}, { agent: a, session: false }),
    ];
  }

  function* tool(
    a: Agent,
    toolName: string,
    summary: string,
    filePaths?: string[],
    failed = false,
  ): Script {
    const toolCallId = nextId("tc");
    const started = at;
    yield [
      ev(
        "tool_call.started",
        { toolCallId, toolName, summary, ...(filePaths === undefined ? {} : { filePaths }) },
        { agent: a },
      ),
    ];
    yield [
      ev(
        "tool_call.finished",
        { toolCallId, phase: failed ? "failed" : "succeeded", durationMs: at - started },
        { agent: a },
      ),
    ];
  }

  /** Waits for queued work: ends the turn once (waiting), then resumes with a new prompt. */
  function* awaitWork(a: Agent): Script {
    while (a.queue.length === 0) {
      a.busy = false;
      if (!a.waiting) {
        a.waiting = true;
        a.activity = "waiting";
        yield [ev("session.turn_ended", {}, { agent: a })];
      } else yield null;
    }
    a.busy = true;
    if (a.waiting) {
      a.waiting = false;
      yield [ev("session.prompt_submitted", {}, { agent: a })];
    }
  }

  function* handoff(from: Agent, to: Agent, task: Task, note: string): Script {
    from.activity = "handing_off";
    to.queue.push(task);
    yield [
      ev(
        "task.handoff",
        { fromAgentId: from.id, toAgentId: to.id, note },
        { agent: from, task: task.id },
      ),
    ];
  }

  /** A subagent run (S-2): Agent tool call, SubagentStart without a parent, the parent link once
   * the tool returns, its own work in the parent's session, then finished. */
  function* subagent(parent: Agent, name: string, role: string, work: string): Script {
    const sub = agent(`sub${++counter}`, name, role, parent.sessionId);
    const subSourceId = `a${rng.hex(16)}`;
    const register = (extra: Record<string, unknown> = {}) =>
      ev(
        "agent.registered",
        { sourceAgentId: subSourceId, displayName: name, role, kind: "subagent", ...extra },
        { agent: sub },
      );
    const toolCallId = nextId("tc");
    const started = at;
    yield [
      ev(
        "tool_call.started",
        { toolCallId, toolName: "Agent", summary: `Launch ${name} subagent` },
        { agent: parent },
      ),
    ];
    yield [register()];
    yield [
      ev(
        "tool_call.finished",
        { toolCallId, phase: "succeeded", durationMs: at - started, summary: "async_launched" },
        { agent: parent },
      ),
      register({ parentAgentId: parent.id }),
    ];
    yield activity(sub, work);
    yield* tool(sub, rng.pick(["Read", "Grep"]), rng.pick(RESEARCH));
    yield [
      ev(
        "agent.finished",
        { outcome: "completed", summary: `${name} finished` },
        { agent: sub, session: false },
      ),
    ];
  }

  /** A small in-process team: Ada leads, a teammate in her session works and messages her. */
  function* crew(lead: Agent): Script {
    const teamId = nextId("team");
    const mateName = rng.pick(MATES);
    const mate = agent(`mate${++counter}`, mateName, mateName, lead.sessionId);
    const toolCallId = nextId("tc");
    const started = at;
    yield [
      ev(
        "tool_call.started",
        { toolCallId, toolName: "Agent", summary: `Spawn teammate ${mateName}` },
        { agent: lead },
      ),
    ];
    yield [
      ev("team.started", { teamId, leadAgentId: lead.id, name: "demo-crew" }),
      registered(lead, "lead", { teamId }),
      ev(
        "agent.registered",
        {
          sourceAgentId: mate.id.slice(prefix.length + 1),
          displayName: mateName,
          role: mateName,
          kind: "teammate",
          teamId,
        },
        { agent: mate },
      ),
      ev(
        "tool_call.finished",
        { toolCallId, phase: "succeeded", durationMs: at - started, summary: "teammate_spawned" },
        { agent: lead },
      ),
    ];
    yield activity(mate, rng.pick(["researching", "testing"]));
    yield* tool(mate, rng.pick(["Read", "Bash"]), rng.pick(RESEARCH));
    yield* tool(mate, "SendMessage", `to ${lead.name}: findings are ready`);
    yield [ev("activity.ended", {}, { agent: mate })];
    yield [
      ev("agent.finished", { outcome: "shutdown" }, { agent: mate, session: false }),
      ev("team.ended", { teamId }),
    ];
  }

  // Role scripts.

  function* dispatcher(me: Agent): Script {
    yield* arrive(me);
    me.busy = true;
    for (;;) {
      if (at >= nextCrewAt) {
        yield* crew(me);
        nextCrewAt = at + rng.int(12, 18) * MIN;
      } else if (openTasks < MAX_OPEN_TASKS && brook.queue.length + cyd.queue.length < 2) {
        openTasks += 1;
        const implementer = brook.queue.length <= cyd.queue.length ? brook : cyd;
        const task: Task = {
          id: nextId("task"),
          title: TITLES[taskCount++ % TITLES.length] ?? "Task",
          implementer,
          reworked: false,
        };
        implementer.queue.push(task);
        yield [
          ...activity(me, "dispatching"),
          ev("task.created", { title: task.title }, { task: task.id }),
          ev("task.assigned", { agentIds: [implementer.id] }, { task: task.id }),
        ];
      } else yield null;
    }
  }

  function* implementer(me: Agent): Script {
    yield* arrive(me);
    let tasks = 0;
    for (;;) {
      yield* awaitWork(me);
      const task = me.queue.shift() as Task;
      tasks += 1;
      yield [
        ev("task.status_changed", { status: "running" }, { agent: me, task: task.id }),
        ...activity(me, "implementing", task.id),
      ];
      if (me === brook && (tasks === 1 || rng.chance(0.35)))
        yield* subagent(me, "explorer", "Explore", "researching");
      for (let i = rng.int(1, 2); i > 0; i--) {
        const file = rng.pick(FILES);
        yield* tool(me, rng.pick(["Edit", "Write"]), `Edit ${file}`, [file], rng.chance(0.1));
      }
      if (tasks % 3 === 2 || rng.chance(0.15)) {
        yield [ev("session.turn_failed", { reason: rng.pick(FAILURES) }, { agent: me })];
        yield [ev("session.prompt_submitted", {}, { agent: me })];
      }
      yield* handoff(me, dee, task, "ready for tests");
    }
  }

  function* tester(me: Agent): Script {
    yield* arrive(me);
    for (;;) {
      yield* awaitWork(me);
      const task = me.queue.shift() as Task;
      yield activity(me, "testing", task.id);
      const failed = !task.reworked && rng.chance(0.25) ? rng.int(1, 3) : 0;
      yield* tool(me, "Bash", "pnpm test", undefined, failed > 0);
      yield [
        ev(
          "test.result",
          { passed: rng.int(40, 120), failed, skipped: rng.int(0, 4) },
          { agent: me, task: task.id },
        ),
      ];
      if (failed > 0) {
        task.reworked = true;
        yield* handoff(me, task.implementer, task, "tests failing, please fix");
      } else yield* handoff(me, eli, task, "tests pass, ready for review");
    }
  }

  function* reviewer(me: Agent): Script {
    yield* arrive(me);
    for (;;) {
      yield* awaitWork(me);
      const task = me.queue.shift() as Task;
      reviewCount += 1;
      yield activity(me, "reviewing", task.id);
      if (reviewCount === 1 || rng.chance(0.35))
        yield* subagent(me, "security-check", "security-reviewer", "reviewing");
      yield* tool(me, "Read", `Review the diff for ${task.title}`, [rng.pick(FILES)]);
      yield [ev("task.status_changed", { status: "completed" }, { agent: me, task: task.id })];
      openTasks -= 1;
      const sha = rng.hex(40);
      const merge = rng.hex(40);
      yield [
        ev("git.commit", { repo: REPO, sha, parents: [mergeHead], subject: task.title }),
        ev("git.merge", { repo: REPO, sha: merge, parents: [mergeHead, sha] }),
      ];
      mergeHead = merge;
      fay.queue.push(task);
    }
  }

  function* documenter(me: Agent): Script {
    yield* arrive(me);
    me.busy = true;
    for (;;) {
      const task = me.queue.shift();
      if (task !== undefined) {
        yield activity(me, "documenting", task.id);
        yield* tool(me, "Write", `Update CHANGELOG for ${task.title}`, ["CHANGELOG.md"]);
      } else {
        yield activity(me, "researching");
        yield* tool(me, rng.pick(["Read", "WebSearch"]), rng.pick(RESEARCH));
      }
    }
  }

  ada.script = dispatcher(ada);
  brook.script = implementer(brook);
  cyd.script = implementer(cyd);
  dee.script = tester(dee);
  eli.script = reviewer(eli);
  fay.script = documenter(fay);

  /** A telemetry-only permission prompt on a working agent; its tool result closes it later. */
  const needsYou = (a: Agent): Beat => {
    const toolCallId = nextId("tc");
    const requestId = nextId("req");
    const command = rng.pick(COMMANDS);
    const started = at;
    a.hold = {
      until: at + rng.int(3, 8) * pace.changeMaxMs,
      close: () => [
        ev(
          "tool_call.finished",
          { toolCallId, phase: "succeeded", durationMs: at - started },
          { agent: a },
        ),
      ],
    };
    blockedSessions.add(a.sessionId);
    return [
      ev("tool_call.started", { toolCallId, toolName: "Bash", summary: command }, { agent: a }),
      ev(
        "request.opened",
        {
          requestId,
          kind: "permission",
          toolName: "Bash",
          inputPreview: command,
          reason: `Bash wants to run: ${command}`,
        },
        { agent: a },
      ),
    ];
  };

  let arrivals = 0;
  for (;;) {
    if (options.durationMs !== undefined && at >= options.durationMs) return;
    let beat: Beat | null = null;
    if (arrivals < team.length) {
      beat = (team[arrivals++]?.script?.next().value as Beat | undefined) ?? null;
    } else {
      const released = team.find((a) => a.hold !== undefined && a.hold.until <= at);
      if (released?.hold !== undefined) {
        beat = released.hold.close();
        blockedSessions.delete(released.sessionId);
        released.hold = undefined;
      } else if (at >= nextNeedsYouAt) {
        const candidates = team.filter(
          (a) => a.hold === undefined && !a.waiting && !blockedSessions.has(a.sessionId),
        );
        if (candidates.length > 0) {
          beat = needsYou(rng.pick(candidates));
          nextNeedsYouAt = at + Math.round(pace.needsYouMs * (0.8 + 0.4 * rng.next()));
        }
      }
      const pool = team.filter((a) => a.hold === undefined && !blockedSessions.has(a.sessionId));
      while (beat === null && pool.length > 0) {
        const index = weightedIndex(
          pool.map((a) => (a.busy ? 3 : 1)),
          rng.next(),
        );
        const chosen = pool.splice(index, 1)[0];
        const value = chosen?.script?.next().value;
        if (value !== null && value !== undefined && value.length > 0) beat = value;
      }
      if (beat === null) {
        // Nothing to show from the agents: the Git watcher reports a commit.
        const sha = rng.hex(40);
        beat = [
          ev("git.commit", {
            repo: REPO,
            sha,
            parents: [mergeHead],
            subject: "Chore: bump dependencies",
          }),
        ];
        mergeHead = sha;
      }
    }
    // Unreachable: an arrival always has a beat, and otherwise the Git fallback supplies one.
    if (beat === null) throw new Error("demo: a step produced no events");
    yield { atMs: at, events: beat };
    at += rng.int(pace.changeMinMs, pace.changeMaxMs);
  }
}

/** All steps with `atMs < durationMs`. */
export function generateDemo(options: DemoOptions & { durationMs: number }): DemoStep[] {
  return [...demoSteps(options)];
}
