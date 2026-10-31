import { describe, expect, it } from "vitest";
import { AREA_IDS } from "../../../src/city/layout/index.ts";
import {
  areaFor,
  DEFAULT_ACTIVITY_AREAS,
  resolveActivityAreas,
} from "../../../src/city/movement/areas.ts";

describe("activity to work area table (ARCHITECTURE.md 8.3)", () => {
  it("maps each activity to its default area, and the rest to no destination", () => {
    const t = DEFAULT_ACTIVITY_AREAS;
    expect(areaFor(t, { activity: "dispatching" })).toBe("dispatch");
    expect(areaFor(t, { activity: "implementing" })).toBe("workshop");
    expect(areaFor(t, { activity: "testing" })).toBe("test_lab");
    expect(areaFor(t, { activity: "reviewing" })).toBe("review");
    expect(areaFor(t, { activity: "researching" })).toBe("archives");
    expect(areaFor(t, { activity: "documenting" })).toBe("archives");
    for (const activity of ["idle", "waiting", "handing_off", "unknown"] as const) {
      expect(areaFor(t, { activity })).toBeNull();
    }
  });

  it("sends reviewer-type and security-type subagents to Review and Security", () => {
    const t = DEFAULT_ACTIVITY_AREAS;
    expect(areaFor(t, { activity: "reviewing", agentType: "security-reviewer" })).toBe("security");
    expect(areaFor(t, { activity: "researching", agentType: "code-reviewer" })).toBe("review");
    expect(areaFor(t, { activity: "researching", agentType: "Explore" })).toBe("archives");
    // Only a subagent's type picks its area; a top-level agent goes where its activity says.
    expect(
      areaFor(t, { activity: "implementing", agentType: "reviewer", kind: "session" }),
    ).toBe("workshop");
  });

  it("is data: overrides replace entries, and bad entries are ignored", () => {
    const t = resolveActivityAreas({
      activities: { implementing: "test_lab", testing: null, reviewing: "nowhere", bogus: "review" },
      agentTypes: [{ match: "doc", area: "archives" }, { match: "", area: "review" }, { area: 3 }],
    });
    expect(areaFor(t, { activity: "implementing" })).toBe("test_lab");
    expect(areaFor(t, { activity: "testing" })).toBeNull();
    expect(areaFor(t, { activity: "reviewing" })).toBe("review");
    expect(areaFor(t, { activity: "implementing", agentType: "docs-writer" })).toBe("archives");
    expect(t.agentTypes).toEqual([{ match: "doc", area: "archives" }]);
    // Defaults are untouched and every area value is a real area.
    expect(areaFor(DEFAULT_ACTIVITY_AREAS, { activity: "implementing" })).toBe("workshop");
    for (const area of Object.values(t.activities)) {
      if (area !== null) expect(AREA_IDS).toContain(area);
    }
  });

  it("falls back to the defaults for input that is not an object", () => {
    for (const input of [undefined, null, 3, "x", [1]]) {
      expect(resolveActivityAreas(input)).toEqual(DEFAULT_ACTIVITY_AREAS);
    }
  });
});
