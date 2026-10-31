import { describe, expect, it } from "vitest";
import { buildModel } from "../src/model.ts";
import { example, NOW } from "./example-snapshot.ts";

describe("buildModel", () => {
  const model = buildModel(example, NOW);
  const keys = (list: { key: string }[]) => list.map((t) => t.key);

  it("takes tickets from [KEY] titles, skipping gates, decisions, and status PRs", () => {
    expect(keys(model.tickets)).toEqual(["M9.01", "M9.02", "M9.03", "M9.04", "M9.05"]);
  });

  it("starts at the first commit of the merged (or latest) PR and ends at its merge", () => {
    const byKey = Object.fromEntries(model.tickets.map((t) => [t.key, t]));
    expect(byKey["M9.01"]).toMatchObject({
      start: "2026-01-01T10:00:00Z",
      end: "2026-01-02T12:00:00Z",
      pr: 10,
    });
    expect(byKey["M9.02"]).toMatchObject({
      start: "2026-01-02T10:00:00Z",
      end: "2026-01-03T10:00:00Z",
      pr: 11,
    });
    expect(byKey["M9.03"]).toMatchObject({ start: "2026-01-03T08:00:00Z", end: null, pr: 12 });
    expect(byKey["M9.05"]).toMatchObject({ start: null, end: null, pr: null });
  });

  it("reads lane and size from the board", () => {
    const t = model.tickets.find((x) => x.key === "M9.03");
    expect(t).toMatchObject({ lane: "Domain", size: "L" });
    expect(model.tickets.find((x) => x.key === "M9.05")?.lane).toBeNull();
  });

  it("splits planned from added at the milestone's first commit", () => {
    expect(model.start).toBe("2026-01-01T10:00:00Z");
    expect(keys(model.planned)).toEqual(["M9.01", "M9.02", "M9.03", "M9.04"]);
    expect(keys(model.added)).toEqual(["M9.05"]);
    expect(keys(model.done)).toEqual(["M9.01", "M9.02"]);
    expect(keys(model.dropped)).toEqual(["M9.04"]);
    expect(keys(model.open)).toEqual(["M9.03", "M9.05"]);
  });

  it("counts open and in-progress tickets per UTC day, up to now", () => {
    expect(model.days).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(model.openPerDay).toEqual([4, 3, 2]);
    expect(model.idealPerDay).toEqual([5, 2.5, 0]);
    expect(model.inProgressPerDay).toEqual([1, 2, 2]);
    expect(model.peakParallel).toBe(2);
  });

  it("averages cycle hours by size and leaves sizes with no merged ticket unmeasured", () => {
    expect(model.cycleHours).toEqual({ S: 26, M: 24, L: null });
  });

  it("classifies reviews of done tickets from their task reports", () => {
    expect(model.reviews).toEqual({ firstPass: 1, oneFix: 1, escalated: 0, notMeasured: [] });
  });

  it("counts CI failures, re-runs, and flakes on ticket branches only", () => {
    // Failures: run 100, plus the failed first attempt of run 102. Cancelled runs are not failures.
    expect(model.ci).toEqual({ failures: 2, reruns: 2, flakes: 1 });
  });

  it("counts done tickets whose report lists something NOT RUN", () => {
    expect(model.notRun).toBe(1);
  });

  it("leaves NOT RUN unmeasured when no done ticket has a report", () => {
    expect(buildModel({ ...example, taskReports: {} }, NOW).notRun).toBeNull();
  });

  it("has no timeline when no ticket has started", () => {
    const quiet = buildModel({ ...example, pulls: [] }, NOW);
    expect(quiet.start).toBeNull();
    expect(quiet.days).toEqual(["2026-01-03"]);
    expect(quiet.inProgressPerDay).toEqual([0]);
    expect(keys(quiet.planned)).toEqual(["M9.01", "M9.02", "M9.03", "M9.04", "M9.05"]);
    expect(keys(quiet.added)).toEqual([]);
  });

  it("ends the timeline at the last merge when every ticket is closed", () => {
    const closed = {
      ...example,
      issues: example.issues.filter((i) => i.state === "closed"),
    };
    expect(buildModel(closed, NOW).days).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    const early = buildModel(closed, new Date("2026-02-01T00:00:00Z"));
    expect(early.days.at(-1)).toBe("2026-01-03");
  });
});
