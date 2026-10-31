import { redactText } from "@taskville/adapters/redact";
import { replay } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import {
  type InputEvent,
  parseInputEvent,
  producerPolicyViolation,
  REASON_MAX_CHARS,
} from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import {
  CALM,
  DEMO_EPOCH_MS,
  generateDemo,
  LIVELY,
  type Pace,
  parsePace,
  toStoredEvents,
} from "../src/index.ts";

const MIN = 60_000;
const parsed = (seed: number, pace: Pace, durationMs: number): InputEvent[] =>
  generateDemo({ seed, pace, durationMs })
    .flatMap((step) => step.events)
    .map((raw) => {
      const result = parseInputEvent(raw);
      if (!result.ok)
        throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
      return result.event;
    });

describe("determinism (US3-1, FR-013)", () => {
  it("gives the same steps for the same seed and pace", () => {
    const a = generateDemo({ seed: 42, pace: CALM, durationMs: 30 * MIN });
    const b = generateDemo({ seed: 42, pace: CALM, durationMs: 30 * MIN });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("differs in timing and choices for a different seed, not only in IDs", () => {
    const a = generateDemo({ seed: 42, pace: CALM, durationMs: 30 * MIN });
    const b = generateDemo({ seed: 43, pace: CALM, durationMs: 30 * MIN });
    expect(a.map((s) => s.atMs)).not.toEqual(b.map((s) => s.atMs));
    const types = (steps: typeof a) => steps.flatMap((s) => s.events.map((e) => e.type)).join(",");
    expect(types(a)).not.toBe(types(b));
  });

  it("differs for a different pace", () => {
    const calm = generateDemo({ seed: 42, pace: CALM, durationMs: 10 * MIN });
    const lively = generateDemo({ seed: 42, pace: LIVELY, durationMs: 10 * MIN });
    expect(lively.length).toBeGreaterThan(calm.length * 3);
  });

  it("is a prefix: a shorter run is the start of a longer one", () => {
    const short = generateDemo({ seed: 5, pace: CALM, durationMs: 10 * MIN });
    const long = generateDemo({ seed: 5, pace: CALM, durationMs: 20 * MIN });
    expect(long.slice(0, short.length)).toEqual(short);
  });
});

describe("pace", () => {
  it.each([
    ["calm", CALM],
    ["lively", LIVELY],
    ["custom", parsePace("change=2s-6s,needs-you=90s")],
  ] as const)("spaces visible changes within the %s interval", (_name, pace) => {
    const steps = generateDemo({ seed: 11, pace, durationMs: 60 * MIN });
    expect(steps[0]?.atMs).toBe(0);
    for (let i = 1; i < steps.length; i++) {
      const gap = (steps[i]?.atMs ?? 0) - (steps[i - 1]?.atMs ?? 0);
      expect(gap).toBeGreaterThanOrEqual(pace.changeMinMs);
      expect(gap).toBeLessThanOrEqual(pace.changeMaxMs);
      expect(steps[i]?.events.length).toBeGreaterThan(0);
    }
  });

  it("opens a needs-you request about every 3 minutes at calm, more often at lively", () => {
    const opened = (pace: Pace) =>
      parsed(3, pace, 3 * 60 * MIN).filter((e) => e.type === "request.opened").length;
    const calm = opened(CALM);
    expect(calm).toBeGreaterThanOrEqual(45);
    expect(calm).toBeLessThanOrEqual(75);
    expect(opened(LIVELY)).toBeGreaterThanOrEqual(calm);
  });
});

describe("every event is valid demo input", () => {
  const events = generateDemo({ seed: 42, pace: CALM, durationMs: 60 * MIN }).flatMap(
    (s) => s.events,
  );

  it("passes protocol validation and the batch route's producer policy", () => {
    for (const raw of events) {
      const result = parseInputEvent(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(true);
      if (result.ok) expect(producerPolicyViolation(result.event)).toBeUndefined();
    }
  });

  it("carries demo provenance from a demo:<seed> source with unique, ordered keys (US3-3)", () => {
    expect(new Set(events.map((e) => e.provenance))).toEqual(new Set(["demo"]));
    expect(new Set(events.map((e) => e.sourceId))).toEqual(new Set(["demo:42"]));
    expect(new Set(events.map((e) => e.sourceEventId)).size).toBe(events.length);
    const sequences = events.map((e) => e.sourceSequence ?? -1);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
  });

  it("stamps events on the virtual clock from the start time", () => {
    const steps = generateDemo({
      seed: 42,
      pace: CALM,
      durationMs: 5 * MIN,
      startAtMs: DEMO_EPOCH_MS,
    });
    for (const step of steps) {
      for (const event of step.events)
        expect(Date.parse(event.occurredAt)).toBe(DEMO_EPOCH_MS + step.atMs);
    }
  });

  it("writes text that redaction leaves unchanged and reasons within 280 characters", () => {
    for (const event of events) {
      const strings = JSON.stringify(event.payload).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
      for (const quoted of strings) {
        const text = JSON.parse(quoted) as string;
        expect(redactText(text).text, text).toBe(text);
      }
      const reason = (event.payload as { reason?: unknown }).reason;
      if (typeof reason === "string")
        expect([...reason].length).toBeLessThanOrEqual(REASON_MAX_CHARS);
    }
  });
});

describe("scenario content", () => {
  const events = parsed(42, CALM, 45 * MIN);
  const of = <T extends InputEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<InputEvent, { type: T }> => e.type === type);

  it("has six top-level agents and work in every area", () => {
    const topLevel = new Set(
      of("agent.registered")
        .filter((e) => e.payload.kind === "session" || e.payload.kind === "lead")
        .map((e) => e.agentId),
    );
    expect(topLevel.size).toBe(6);
    const activities = new Set(of("activity.started").map((e) => e.payload.activity));
    for (const activity of [
      "dispatching",
      "implementing",
      "testing",
      "reviewing",
      "researching",
      "documenting",
    ]) {
      expect(activities, activity).toContain(activity);
    }
    // The Security area is reached through security-type subagents (ARCHITECTURE.md 8.3).
    expect(
      of("agent.registered").some(
        (e) => e.payload.kind === "subagent" && e.payload.role === "security-reviewer",
      ),
    ).toBe(true);
  });

  it("has handoffs, completions, a merge, trouble, and waiting", () => {
    expect(of("task.handoff").length).toBeGreaterThan(0);
    expect(of("task.status_changed").some((e) => e.payload.status === "completed")).toBe(true);
    expect(of("git.merge").length).toBeGreaterThan(0);
    expect(of("test.result").length).toBeGreaterThan(0);
    expect(of("session.turn_failed").length).toBeGreaterThan(0);
    expect(of("session.turn_ended").length).toBeGreaterThan(0);
  });

  it("has two subagents per crew episode, linked to their parent after launch as in S-2", () => {
    const subs = of("agent.registered").filter((e) => e.payload.kind === "subagent");
    const linked = new Set(
      subs.filter((e) => e.payload.parentAgentId !== undefined).map((e) => e.agentId),
    );
    expect(linked.size).toBeGreaterThanOrEqual(2);
    for (const id of linked) {
      const regs = subs.filter((e) => e.agentId === id);
      expect(regs[0]?.payload.parentAgentId).toBeUndefined();
      expect(regs.at(-1)?.payload.parentAgentId).toBeDefined();
    }
    expect(of("agent.finished").length).toBeGreaterThan(0);
  });

  it("has a small team whose teammate shares the lead's session and sends a message", () => {
    const team = of("team.started")[0];
    expect(team).toBeDefined();
    const mates = of("agent.registered").filter((e) => e.payload.kind === "teammate");
    expect(mates.length).toBeGreaterThan(0);
    const lead = of("agent.registered").find((e) => e.payload.kind === "lead");
    expect(lead?.payload.teamId).toBe(team?.payload.teamId);
    const mate = mates[0];
    const leadSession = of("session.started").find(
      (e) => e.agentId === team?.payload.leadAgentId,
    )?.sessionId;
    const message = of("tool_call.started").find(
      (e) => e.agentId === mate?.agentId && e.payload.toolName === "SendMessage",
    );
    expect(message?.sessionId).toBe(leadSession);
    expect(of("team.ended").map((e) => e.payload.teamId)).toContain(team?.payload.teamId);
  });

  it("moves tasks through the task graph without transition warnings", () => {
    const stored = toStoredEvents(
      generateDemo({ seed: 42, pace: CALM, durationMs: 2 * 60 * MIN }).flatMap((s) => s.events),
      "demo",
    );
    const tasks = Object.values(replay("demo", stored).tasks);
    expect(tasks.some((t) => t.status === "completed")).toBe(true);
    expect(tasks.filter((t) => t.transitionWarning !== undefined)).toEqual([]);
    expect(of("task.status_changed").some((e) => e.payload.status === "reviewing")).toBe(true);
  });

  it("gives runs that start a millisecond apart different event keys", () => {
    const key = (startAtMs: number) =>
      generateDemo({ seed: 1, pace: CALM, durationMs: MIN, startAtMs })[0]?.events[0]
        ?.sourceEventId;
    expect(key(DEMO_EPOCH_MS)).not.toBe(key(DEMO_EPOCH_MS + 1));
    expect(key(DEMO_EPOCH_MS)).toBe(key(DEMO_EPOCH_MS));
  });

  it("never emits engine-only types", () => {
    expect(
      events.filter(
        (e) =>
          e.type.startsWith("command.") ||
          e.type === "request.resolved" ||
          e.type === "request.expired" ||
          e.type === "project.created",
      ),
    ).toEqual([]);
  });
});

describe("needs-you moments are honest about what is answerable", () => {
  const steps = generateDemo({ seed: 42, pace: CALM, durationMs: 60 * MIN });
  const stored = toStoredEvents(
    steps.flatMap((s) => s.events),
    "demo",
  );
  const state = replay("demo", stored);

  it("opens permission requests that are never answerable and close in the agent's own terminal", () => {
    const requests = Object.values(state.requests);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.answerable).toBe(false);
      expect(request.kind).toBe("permission");
    }
    const closed = requests.filter((r) => r.state !== "open");
    expect(closed.length).toBeGreaterThan(0);
    for (const request of closed) expect(request.state).toBe("answered_elsewhere");
  });

  it("keeps the agent red until its tool result, with nothing else on that session meanwhile", () => {
    const events = stored;
    for (const [i, event] of events.entries()) {
      if (event.type !== "request.opened") continue;
      const close = events.findIndex(
        (e, j) =>
          j > i &&
          e.sessionId === event.sessionId &&
          (e.type.startsWith("session.") || e.type === "tool_call.finished"),
      );
      if (close === -1) continue;
      const closing = events[close];
      expect(closing?.type).toBe("tool_call.finished");
      expect(closing?.agentId).toBe(event.agentId);
      const between = events.slice(i + 1, close).filter((e) => e.sessionId === event.sessionId);
      expect(between).toEqual([]);
      const held = Date.parse(closing?.occurredAt ?? "") - Date.parse(event.occurredAt);
      expect(held).toBeGreaterThanOrEqual(2 * CALM.changeMinMs);
    }
  });
});

describe("US3-2: within 10 simulated minutes at calm", () => {
  it.each(Array.from({ length: 20 }, (_, i) => i + 1))(
    "seed %i: someone needed you, a handoff happened, someone works",
    (seed) => {
      const steps = generateDemo({ seed, pace: CALM, durationMs: 10 * MIN });
      const stored = toStoredEvents(
        steps.flatMap((s) => s.events),
        "demo",
      );
      let sawNeedsYou = false;
      for (let n = 1; n <= stored.length; n++) {
        const event = stored[n - 1];
        if (event?.type !== "request.opened") continue;
        const state = replay("demo", stored.slice(0, n));
        const now = Date.parse(event.occurredAt);
        if (attention(state, now).some((a) => a.level === "needs_you")) sawNeedsYou = true;
      }
      expect(sawNeedsYou).toBe(true);
      expect(stored.some((e) => e.type === "task.handoff")).toBe(true);
      const final = replay("demo", stored);
      const working = Object.values(final.activity).filter(
        (a) => a.activity !== "idle" && a.activity !== "waiting",
      );
      expect(working.length).toBeGreaterThan(0);
    },
  );
});
