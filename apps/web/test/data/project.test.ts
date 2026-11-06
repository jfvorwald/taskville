import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID, pickDefaultProject } from "../../src/data/project.ts";

// M7.21: which project the city opens on. The viewer's remembered choice wins while that project
// still exists; otherwise the most recently active user project; otherwise Unsorted.

const unsorted = { id: "unsorted", name: "Unsorted", roots: [], builtin: true, head: 90 };
const alpha = { id: "alpha", name: "Alpha", roots: ["/a"], builtin: false, head: 10 };
const beta = { id: "beta", name: "Beta", roots: ["/b"], builtin: false, head: 40 };

describe("pickDefaultProject", () => {
  it("prefers the remembered project when it still exists", () => {
    expect(pickDefaultProject([unsorted, alpha, beta], "alpha")).toBe("alpha");
  });

  it("honours a remembered Unsorted", () => {
    expect(pickDefaultProject([unsorted, alpha, beta], "unsorted")).toBe("unsorted");
  });

  it("falls back to the non-builtin project with the highest head when nothing is remembered", () => {
    expect(pickDefaultProject([unsorted, alpha, beta], null)).toBe("beta");
  });

  it("falls back the same way when the remembered project no longer exists", () => {
    expect(pickDefaultProject([unsorted, alpha, beta], "gone")).toBe("beta");
  });

  it("ignores the builtin project's head even when it is the highest", () => {
    expect(pickDefaultProject([unsorted, alpha], null)).toBe("alpha");
  });

  it("falls back to unsorted when there is no user project", () => {
    expect(pickDefaultProject([unsorted], null)).toBe(DEFAULT_PROJECT_ID);
    expect(pickDefaultProject([], null)).toBe(DEFAULT_PROJECT_ID);
  });
});

// M7.22: the default follows last activity time, not event count. `lastEventAt` is an ISO string
// on each `GET /v1/projects` row. The protocol type does not carry it yet, so the rows are loosely
// typed here.
describe("pickDefaultProject by last activity", () => {
  const withTime = (p: typeof alpha, lastEventAt: string) => ({ ...p, lastEventAt }) as typeof p;
  const oldBusy = withTime({ ...alpha, id: "old-busy", head: 5000 }, "2026-01-05T09:00:00.000Z");
  const recentQuiet = withTime(
    { ...beta, id: "recent-quiet", head: 3 },
    "2026-11-05T17:30:00.000Z",
  );

  it("prefers a recent quiet project over an old busy one", () => {
    expect(pickDefaultProject([unsorted, oldBusy, recentQuiet], null)).toBe("recent-quiet");
  });

  it("does not depend on list order", () => {
    expect(pickDefaultProject([recentQuiet, oldBusy, unsorted], null)).toBe("recent-quiet");
  });

  it("still lets a remembered choice win over recency", () => {
    expect(pickDefaultProject([unsorted, oldBusy, recentQuiet], "old-busy")).toBe("old-busy");
  });
});
