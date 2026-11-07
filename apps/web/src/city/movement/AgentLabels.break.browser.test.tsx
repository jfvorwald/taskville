import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../../overlays/host/anchors.ts";
import type { AnchorSource, OverlayProps } from "../../overlays/host/types.ts";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { AgentLabels } from "./AgentLabels.tsx";
import { type MovementLabel, movementLabels } from "./labels.ts";

// M9.04: the world label of a waiting agent on break keeps "Waiting" and adds a secondary note.
// Markup pinned: inside the label element (data-testid="agent-label"), the status span still reads
// exactly "Waiting" and a separate element data-testid="agent-label-on-break" reads "on break".
// The note rides on `MovementLabel.onBreak` (the city sets it from the break plan in M9.05) and
// shows only for a Waiting status while the Break time setting is on.
// Run: pnpm --filter @taskville/web test:browser src/city/movement/AgentLabels.break

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function anchorsFor(ids: readonly string[]): AnchorSource {
  const source = createAnchorSource();
  for (const [i, id] of ids.entries()) source.setAnchor(`agent:${id}`, [-0.8 + i * 0.4, 0, 0]);
  source.setProjection(IDENTITY, { width: 900, height: 600 });
  return source;
}

const props = (anchors: AnchorSource): OverlayProps => ({
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: null, select: () => {} },
  anchors,
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
});

const row = (over: Partial<MovementLabel> & Pick<MovementLabel, "id" | "name">): MovementLabel => ({
  status: "Waiting",
  onTheWay: false,
  state: "idle",
  urgent: false,
  ...over,
});

const label = (id: string) =>
  document.querySelector(`[data-testid="agent-label"][data-agent-id="${id}"]`) as HTMLElement;
const note = (id: string) => label(id)?.querySelector('[data-testid="agent-label-on-break"]');

afterEach(() => {
  movementLabels.set([]);
  getSettingsStore().set("breakTime", true);
});

describe("AgentLabels on break", () => {
  it("keeps Waiting and adds an 'on break' note for an agent on break", async () => {
    movementLabels.set([row({ id: "a1", name: "Ada", onBreak: true })]);
    await render(<AgentLabels {...props(anchorsFor(["a1"]))} />);
    await expect.poll(() => label("a1")).not.toBeNull();
    expect(label("a1").textContent).toContain("Waiting");
    expect(note("a1")?.textContent).toBe("on break");
  });

  it("shows no note for a waiting agent that is not on break", async () => {
    movementLabels.set([row({ id: "a1", name: "Ada" })]);
    await render(<AgentLabels {...props(anchorsFor(["a1"]))} />);
    await expect.poll(() => label("a1")).not.toBeNull();
    expect(label("a1").textContent).toContain("Waiting");
    expect(note("a1")).toBeNull();
    expect(label("a1").textContent).not.toMatch(/on break/i);
  });

  it("shows no note for needs-you, trouble or working labels with a stale flag", async () => {
    movementLabels.set([
      row({ id: "n", name: "Nia", status: "Needs you", urgent: true, onBreak: true }),
      row({ id: "t", name: "Tom", status: "Trouble", onBreak: true }),
      row({ id: "w", name: "Wes", status: "Testing", state: "working", onBreak: true }),
    ]);
    await render(<AgentLabels {...props(anchorsFor(["n", "t", "w"]))} />);
    await expect.poll(() => label("w")).not.toBeNull();
    for (const id of ["n", "t", "w"]) {
      expect(note(id)).toBeNull();
      expect(label(id).textContent).not.toMatch(/on break/i);
    }
  });

  it("shows no note with Break time off, and brings it back when turned on", async () => {
    getSettingsStore().set("breakTime", false);
    movementLabels.set([row({ id: "a1", name: "Ada", onBreak: true })]);
    await render(<AgentLabels {...props(anchorsFor(["a1"]))} />);
    await expect.poll(() => label("a1")).not.toBeNull();
    expect(note("a1")).toBeNull();
    expect(document.body.textContent).not.toMatch(/on break/i);
    getSettingsStore().set("breakTime", true);
    await expect.poll(() => note("a1")?.textContent).toBe("on break");
  });
});
