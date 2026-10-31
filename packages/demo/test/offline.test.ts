import { projectStateHash, replay } from "@taskville/domain/reducer";
import { storedEnvelopeSchema } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { CALM, generateDemo, LIVELY, runOffline, toStoredEvents } from "../src/index.ts";

const MIN = 60_000;

describe("runOffline (cli.md `demo run --offline`)", () => {
  it("gives the same events and stateHash for the same seed and pace", () => {
    const a = runOffline({ seed: 42, pace: CALM, durationMs: 2 * 60 * MIN });
    const b = runOffline({ seed: 42, pace: CALM, durationMs: 2 * 60 * MIN });
    expect(a.stateHash).toBe(b.stateHash);
    expect(a.stateHash).toMatch(/^5:[0-9a-f]{64}$/);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it("gives a different hash for a different seed or pace", () => {
    const base = runOffline({ seed: 42, pace: CALM, durationMs: 30 * MIN }).stateHash;
    expect(runOffline({ seed: 43, pace: CALM, durationMs: 30 * MIN }).stateHash).not.toBe(base);
    expect(runOffline({ seed: 42, pace: LIVELY, durationMs: 30 * MIN }).stateHash).not.toBe(base);
  });

  it("hashes what the reducer computes from the stored events", () => {
    const run = runOffline({ seed: 7, pace: CALM, durationMs: 20 * MIN, projectId: "p1" });
    expect(run.state.projectId).toBe("p1");
    expect(projectStateHash(replay("p1", run.events))).toBe(run.stateHash);
    expect(run.state.head).toBe(run.events.length);
  });

  it("stores events as the engine would: valid envelopes, gap-free sequence, unique IDs", () => {
    const { events } = runOffline({ seed: 1, pace: CALM, durationMs: 30 * MIN });
    expect(events.map((e) => e.ingestSequence)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    for (const event of events) {
      expect(storedEnvelopeSchema.safeParse(event).success).toBe(true);
      expect(event.receivedAt).toBe(event.occurredAt);
    }
  });

  it("stores reasons in their masked-and-truncated form", () => {
    const stored = toStoredEvents(
      generateDemo({ seed: 2, pace: CALM, durationMs: 60 * MIN }).flatMap((s) => s.events),
      "demo",
    );
    const reasons = stored.flatMap((e) => {
      const reason = (e.payload as { reason?: unknown }).reason;
      return reason === undefined ? [] : [reason];
    });
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).toEqual({ text: expect.any(String), masked: false, truncated: false });
    }
  });

  it("rejects a project the demo cannot write to, rather than storing invalid events", () => {
    expect(() => runOffline({ seed: 1, pace: CALM, durationMs: MIN, projectId: "" })).toThrow();
  });

  it("runs an 8-hour calm demo offline in a few seconds (soak input for M1.21)", () => {
    const started = performance.now();
    const run = runOffline({ seed: 42, pace: CALM, durationMs: 8 * 60 * MIN });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(Object.keys(run.state.agents).length).toBeLessThan(400);
  });
});
