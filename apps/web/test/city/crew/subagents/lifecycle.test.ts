import { describe, expect, it } from "vitest";
import {
  FADE_MS,
  HAND_OVER_MS,
  initialLifecycle,
  observeSubagent,
  parentIsWaiting,
  RETURN_MS,
  type SubagentPhase,
  subagentFrame,
  WALK_OUT_MS,
} from "../../../../src/city/crew/subagents/lifecycle.ts";

const T0 = 10_000;

function started(at = T0) {
  return observeSubagent(initialLifecycle(), { kind: "started", atMs: at });
}

function finishedAt(finishAt: number, startAt = T0) {
  return observeSubagent(started(startAt), { kind: "finished", atMs: finishAt });
}

describe("subagent lifecycle", () => {
  it("is absent before any event is observed", () => {
    expect(subagentFrame(initialLifecycle(), T0).phase).toBe("absent");
  });

  it("walks out of the parent's door once it starts, then works", () => {
    const s = started();
    expect(subagentFrame(s, T0).phase).toBe("walking_out");
    expect(subagentFrame(s, T0 + WALK_OUT_MS - 1).phase).toBe("walking_out");
    expect(subagentFrame(s, T0 + WALK_OUT_MS).phase).toBe("working");
  });

  it("reports progress through the walk from 0 to 1", () => {
    const s = started();
    expect(subagentFrame(s, T0).progress).toBe(0);
    expect(subagentFrame(s, T0 + WALK_OUT_MS / 2).progress).toBeCloseTo(0.5);
  });

  it("never leaves working without a finish event, however much time passes", () => {
    const s = started();
    const later = subagentFrame(s, T0 + 24 * 60 * 60 * 1000);
    expect(later.phase).toBe("working");
    expect(later.carrying).toBe(false);
    expect(later.opacity).toBe(1);
  });

  it("does not run the clock backwards (now before the start stays at the start)", () => {
    expect(subagentFrame(started(), T0 - 500).phase).toBe("walking_out");
  });

  it("returns with a result cube, hands it over, fades, and is gone, from the finish event", () => {
    const f = T0 + 60_000;
    const s = finishedAt(f);
    const at = (dt: number): SubagentPhase => subagentFrame(s, f + dt).phase;
    expect(at(0)).toBe("returning");
    expect(at(RETURN_MS - 1)).toBe("returning");
    expect(at(RETURN_MS)).toBe("handing_over");
    expect(at(RETURN_MS + HAND_OVER_MS - 1)).toBe("handing_over");
    expect(at(RETURN_MS + HAND_OVER_MS)).toBe("fading");
    expect(at(RETURN_MS + HAND_OVER_MS + FADE_MS - 1)).toBe("fading");
    expect(at(RETURN_MS + HAND_OVER_MS + FADE_MS)).toBe("gone");
  });

  it("carries the result cube while returning and handing over, and not otherwise", () => {
    const f = T0 + 60_000;
    const s = finishedAt(f);
    expect(subagentFrame(s, f).carrying).toBe(true);
    expect(subagentFrame(s, f + RETURN_MS).carrying).toBe(true);
    expect(subagentFrame(s, f + RETURN_MS + HAND_OVER_MS).carrying).toBe(false);
    expect(subagentFrame(started(), T0 + WALK_OUT_MS).carrying).toBe(false);
  });

  it("stays opaque until the fade, then fades to nothing at the door", () => {
    const f = T0 + 60_000;
    const s = finishedAt(f);
    const fadeStart = f + RETURN_MS + HAND_OVER_MS;
    expect(subagentFrame(s, fadeStart - 1).opacity).toBe(1);
    expect(subagentFrame(s, fadeStart).opacity).toBe(1);
    expect(subagentFrame(s, fadeStart + FADE_MS / 2).opacity).toBeCloseTo(0.5);
    expect(subagentFrame(s, fadeStart + FADE_MS).opacity).toBe(0);
  });

  it("heads home at the finish event even if the walk out was not done", () => {
    const f = T0 + 100;
    expect(f - T0).toBeLessThan(WALK_OUT_MS);
    expect(subagentFrame(finishedAt(f), f).phase).toBe("returning");
  });

  it("ignores a repeated start or finish, so a replayed event never restarts the clock", () => {
    const f = T0 + 60_000;
    let s = finishedAt(f);
    s = observeSubagent(s, { kind: "started", atMs: f + 5000 });
    s = observeSubagent(s, { kind: "finished", atMs: f + 7000 });
    expect(subagentFrame(s, f + RETURN_MS).phase).toBe("handing_over");
  });

  it("does not mutate the state it was given", () => {
    const before = started();
    const snapshot = JSON.stringify(before);
    observeSubagent(before, { kind: "finished", atMs: T0 + 1 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("parentIsWaiting", () => {
  it("is false for a parent with no subagents in flight", () => {
    expect(parentIsWaiting([])).toBe(false);
    expect(parentIsWaiting(["absent", "gone", "fading"])).toBe(false);
  });

  it("is true while any subagent is walking out or working", () => {
    expect(parentIsWaiting(["working"])).toBe(true);
    expect(parentIsWaiting(["gone", "walking_out"])).toBe(true);
    expect(parentIsWaiting(["fading", "working", "gone"])).toBe(true);
  });
});
