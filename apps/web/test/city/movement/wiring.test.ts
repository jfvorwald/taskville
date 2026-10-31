import { describe, expect, it } from "vitest";
import { areaFor } from "../../../src/city/movement/areas.ts";
import { countsSelector } from "../../../src/city/movement/selectors.ts";
import { AREA_OVERRIDES_KEY, loadActivityAreas } from "../../../src/city/movement/settings.ts";
import { initialState } from "../../../src/data/domain.ts";
import { createDataStore } from "../../../src/data/store.ts";
import { eventBuilder, PROJECT, registered } from "../../data/fake-engine.ts";

describe("header counts over the data store", () => {
  it("counts live agents, and keeps its snapshot until the counts change", () => {
    const store = createDataStore({ now: () => Date.parse("2026-10-30T10:30:00Z") });
    const counts = countsSelector(store);
    let calls = 0;
    const off = counts.subscribe(() => calls++);
    const empty = counts.getSnapshot();
    expect(empty).toEqual({ active: 0, needsYou: 0 });

    const emit = eventBuilder();
    store.getState().reset(PROJECT);
    store.getState().applySnapshotState(initialState(PROJECT));
    expect(counts.getSnapshot()).toBe(empty);
    for (const event of registered(emit, "a1", "a2")) store.getState().applyEvent(event);
    const two = counts.getSnapshot();
    expect(two).toEqual({ active: 2, needsYou: 0 });
    expect(counts.getSnapshot()).toBe(two);
    expect(calls).toBeGreaterThan(0);
    off();
  });
});

describe("stored activity-to-area overrides", () => {
  const storage = (value: string | null, broken = false) => ({
    getItem(key: string) {
      if (broken) throw new Error("blocked");
      return key === AREA_OVERRIDES_KEY ? value : null;
    },
  });

  it("applies a stored table and falls back to the defaults on anything else", () => {
    const custom = loadActivityAreas(
      storage(JSON.stringify({ activities: { testing: "review" } })),
    );
    expect(areaFor(custom, { activity: "testing" })).toBe("review");
    for (const t of [
      loadActivityAreas(null),
      loadActivityAreas(storage(null)),
      loadActivityAreas(storage("{not json")),
      loadActivityAreas(storage("x", true)),
    ]) {
      expect(areaFor(t, { activity: "testing" })).toBe("test_lab");
    }
  });
});
