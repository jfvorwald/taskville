import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../host/anchors.ts";
import type { AgentCounts, OverlayProps, Selector } from "../host/types.ts";
import { CountsHeader, countsHeaderOverlay } from "./CountsHeader.tsx";

function counts(initial: AgentCounts) {
  let value = initial;
  const listeners = new Set<() => void>();
  const selector: Selector<AgentCounts> = {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => value,
  };
  return {
    selector,
    set(next: AgentCounts) {
      value = next;
      for (const l of listeners) l();
    },
  };
}

function props(selector: Selector<AgentCounts>): OverlayProps {
  return {
    mode: "live",
    selectors: { counts: selector },
    selection: { selectedId: null, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

describe("CountsHeader", () => {
  it("shows the counts line", async () => {
    const c = counts({ active: 3, needsYou: 1 });
    await render(<CountsHeader {...props(c.selector)} />);
    await expect.element(page.getByText("3 active · 1 needs you")).toBeVisible();
  });

  it("updates when the selector changes", async () => {
    const c = counts({ active: 3, needsYou: 1 });
    await render(<CountsHeader {...props(c.selector)} />);
    await expect.element(page.getByText("3 active · 1 needs you")).toBeVisible();
    c.set({ active: 4, needsYou: 0 });
    await expect.element(page.getByText("4 active · 0 need you")).toBeVisible();
  });

  it("is a live status region that spells the counts out", async () => {
    const c = counts({ active: 2, needsYou: 1 });
    await render(<CountsHeader {...props(c.selector)} />);
    await expect
      .element(page.getByRole("status", { name: "2 agents active, 1 needs you" }))
      .toBeVisible();
  });

  it("is registered for the header slot in both modes", () => {
    expect(countsHeaderOverlay).toMatchObject({ id: "counts-header", slot: "header" });
    expect(countsHeaderOverlay.modes).toEqual(["live", "history"]);
  });
});
