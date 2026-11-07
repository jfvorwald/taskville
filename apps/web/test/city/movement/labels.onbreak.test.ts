import { describe, expect, it } from "vitest";
import { createLabelStore, type MovementLabel } from "../../../src/city/movement/labels.ts";

// M9.04 roborev 7320: a label update whose only change is `onBreak` must be published, or the
// world label and the agent list keep a stale "on break" note.

const row = (extra: Partial<MovementLabel> = {}): MovementLabel => ({
  id: "a",
  name: "A",
  status: "Waiting",
  onTheWay: false,
  state: "idle",
  urgent: false,
  ...extra,
});

describe("label store onBreak changes", () => {
  it("publishes an update that only turns onBreak on", () => {
    const store = createLabelStore();
    let notified = 0;
    store.set([row()]);
    store.subscribe(() => notified++);
    store.set([row({ onBreak: true })]);
    expect(notified).toBe(1);
    expect(store.getSnapshot()[0]?.onBreak).toBe(true);
  });

  it("publishes an update that only turns onBreak off", () => {
    const store = createLabelStore();
    let notified = 0;
    store.set([row({ onBreak: true })]);
    store.subscribe(() => notified++);
    store.set([row()]);
    expect(notified).toBe(1);
    expect(store.getSnapshot()[0]?.onBreak).toBeUndefined();
  });

  it("still skips an update with identical onBreak", () => {
    const store = createLabelStore();
    let notified = 0;
    store.set([row({ onBreak: true })]);
    store.subscribe(() => notified++);
    store.set([row({ onBreak: true })]);
    expect(notified).toBe(0);
  });
});
