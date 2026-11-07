import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { type MovementLabel, movementLabels } from "../../city/movement/labels.ts";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayProps } from "../host/types.ts";
import { getSettingsStore } from "../settings/store.ts";
import { AgentList } from "./AgentList.tsx";

// M9.04: the accessible agent list says "on break" for a waiting agent the break plan has on a
// break. The note rides on the label row (`MovementLabel.onBreak`, set by the city from the plan in
// M9.05) and shows only for a Waiting status while the Break time setting is on.
// Run: pnpm --filter @taskville/web test:browser src/overlays/agent-list/AgentList.break

const row = (over: Partial<MovementLabel> & Pick<MovementLabel, "id" | "name">): MovementLabel => ({
  status: "Waiting",
  onTheWay: false,
  state: "idle",
  urgent: false,
  ...over,
});

const props: OverlayProps = {
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: null, select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
};

afterEach(() => {
  movementLabels.set([]);
  getSettingsStore().set("breakTime", true);
});

describe("AgentList on break", () => {
  it("names a waiting agent on break 'Name, Waiting, on break'", async () => {
    movementLabels.set([row({ id: "a1", name: "Ada", onBreak: true })]);
    await render(<AgentList {...props} />);
    await expect.element(page.getByRole("row", { name: "Ada, Waiting, on break" })).toBeVisible();
    expect(document.querySelector('[role="row"]')?.textContent).toMatch(/Waiting.*on break/);
  });

  it("reads as today for a waiting agent that is not on break", async () => {
    movementLabels.set([row({ id: "a1", name: "Ada" })]);
    await render(<AgentList {...props} />);
    await expect.element(page.getByRole("row", { name: "Ada, Waiting" })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/on break/i);
  });

  it("shows no note for needs-you, trouble or working rows with a stale flag", async () => {
    movementLabels.set([
      row({ id: "n", name: "Nia", status: "Needs you", urgent: true, onBreak: true }),
      row({ id: "t", name: "Tom", status: "Trouble", onBreak: true }),
      row({ id: "w", name: "Wes", status: "Testing", state: "working", onBreak: true }),
    ]);
    await render(<AgentList {...props} />);
    await expect.element(page.getByRole("row", { name: "Wes, Testing" })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/on break/i);
  });

  it("shows no note anywhere with Break time off, and brings it back when turned on", async () => {
    movementLabels.set([row({ id: "a1", name: "Ada", onBreak: true })]);
    getSettingsStore().set("breakTime", false);
    await render(<AgentList {...props} />);
    await expect.element(page.getByRole("row", { name: "Ada, Waiting" })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/on break/i);
    getSettingsStore().set("breakTime", true);
    await expect.element(page.getByRole("row", { name: "Ada, Waiting, on break" })).toBeVisible();
  });
});
