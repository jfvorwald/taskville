import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { movementLabels } from "../../city/movement/labels.ts";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayProps } from "../host/types.ts";
import { AgentList } from "./AgentList.tsx";

// M3.14 code-review fix (S5): the selected row must carry an accessible state, not only a
// styling hook, so a screen reader user hears which agent is selected.

const rows = [
  {
    id: "a1",
    name: "Ada",
    status: "Testing",
    onTheWay: false,
    state: "working" as const,
    urgent: false,
  },
  {
    id: "b2",
    name: "Brook",
    status: "Idle",
    onTheWay: false,
    state: "idle" as const,
    urgent: false,
  },
];

function props(selectedId: string | null): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

afterEach(() => movementLabels.set([]));

describe("AgentList selection state", () => {
  it("marks the selected row aria-current=true and no other row", async () => {
    movementLabels.set(rows);
    await render(<AgentList {...props("b2")} />);
    await expect
      .element(page.getByRole("row", { name: /Brook/ }))
      .toHaveAttribute("aria-current", "true");
    await expect
      .element(page.getByRole("row", { name: /Ada/ }))
      .not.toHaveAttribute("aria-current");
  });

  it("marks no row when nothing is selected", async () => {
    movementLabels.set(rows);
    await render(<AgentList {...props(null)} />);
    await expect
      .element(page.getByRole("row", { name: /Ada/ }))
      .not.toHaveAttribute("aria-current");
    await expect
      .element(page.getByRole("row", { name: /Brook/ }))
      .not.toHaveAttribute("aria-current");
  });
});
