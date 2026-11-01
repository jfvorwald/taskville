import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { movementLabels } from "../../city/movement/labels.ts";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayProps } from "../host/types.ts";
import { AgentList } from "./AgentList.tsx";

// M3.14 code-review fix (S5): the selected row must carry an accessible state, not only a
// styling hook, so a screen reader user hears which agent is selected. React Aria's GridListItem
// filters out aria-current, so the list uses GridList single selection (aria-selected) bound to
// the M3.11 selection.

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
  it("marks the selected row aria-selected=true and no other row", async () => {
    movementLabels.set(rows);
    await render(<AgentList {...props("b2")} />);
    await expect
      .element(page.getByRole("row", { name: /Brook/ }))
      .toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("row", { name: /Ada/ }))
      .not.toHaveAttribute("aria-selected", "true");
  });

  it("marks no row when nothing is selected", async () => {
    movementLabels.set(rows);
    await render(<AgentList {...props(null)} />);
    await expect
      .element(page.getByRole("row", { name: /Ada/ }))
      .not.toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("row", { name: /Brook/ }))
      .not.toHaveAttribute("aria-selected", "true");
  });

  it("does not change the city selection when arrow keys only move focus between rows", async () => {
    // React Aria's selectionBehavior="replace" selects on focus, which would make browsing the
    // list select every row it passes. Only Enter (or a click) should select.
    movementLabels.set(rows);
    const picked: string[] = [];
    const p = props(null);
    p.selection = {
      selectedId: null,
      select: (id) => {
        if (id !== null) picked.push(id);
      },
    };
    await render(<AgentList {...p} />);
    (page.getByRole("row", { name: /Ada/ }).element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("row", { name: /Brook/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(page.getByRole("row", { name: /Ada/ })).toHaveFocus();
    expect(picked).toEqual([]);

    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(picked).toEqual(["b2"]);
  });
});
