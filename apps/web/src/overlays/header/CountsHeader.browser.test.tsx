import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, projectSelection, selectProject } from "../../data/project.ts";
import { createAnchorSource } from "../host/anchors.ts";
import type { AgentCounts, OverlayProps, Selector } from "../host/types.ts";
import { EMPTY_ATTENTION_FEED } from "./attention.ts";
import { attentionStore } from "./attentionSync.ts";
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

// M4.01 (roborev 5812, 5814, 5817): the needs-you count spans every project, so once the global
// feed has delivered its first snapshot it comes from the feed; before that, from this project.

const T = "2026-10-30T11:00:00.000Z";
const waiting = (agentId: string, requestId: string) => ({
  agentId,
  level: "needs_you" as const,
  kind: "permission" as const,
  since: T,
  requestId,
  heuristic: false,
});
const projectOf = (projectId: string, name: string, agents: string[]) => ({
  projectId,
  name,
  attention: agents.map((a) => waiting(a, `r-${projectId}-${a}`)),
});

afterEach(() => {
  attentionStore.setState({ feed: EMPTY_ATTENTION_FEED, ready: false });
  selectProject(DEFAULT_PROJECT_ID);
});

describe("CountsHeader needs-you count from the global feed", () => {
  it("keeps historical counts recorded while the live global feed changes, then resumes live totals", async () => {
    const c = counts({ active: 2, needsYou: 1 });
    attentionStore.setState({
      feed: { beta: projectOf("beta", "Beta", ["b", "c", "d"]) },
      ready: true,
    });
    const screen = await render(<CountsHeader {...props(c.selector)} mode="history" />);
    await expect.element(page.getByText("2 active · 1 needs you")).toBeVisible();
    attentionStore.setState({
      feed: { beta: projectOf("beta", "Beta", ["b", "c"]) },
    });
    await expect.element(page.getByText("2 active · 1 needs you")).toBeVisible();
    c.set({ active: 1, needsYou: 0 });
    await expect.element(page.getByText("1 active · 0 need you")).toBeVisible();
    await screen.rerender(<CountsHeader {...props(c.selector)} mode="live" />);
    await expect.element(page.getByText("1 active · 2 need you")).toBeVisible();
  });

  it("sums needs-you across projects once the feed is ready, not this project's own count", async () => {
    const c = counts({ active: 3, needsYou: 1 });
    attentionStore.setState({
      feed: {
        unsorted: projectOf("unsorted", "Unsorted", ["a"]),
        beta: projectOf("beta", "Beta", ["b", "c"]),
      },
      ready: true,
    });
    await render(<CountsHeader {...props(c.selector)} />);
    await expect.element(page.getByText("3 active · 3 need you")).toBeVisible();
    await expect
      .element(page.getByRole("status", { name: "3 agents active, 3 need you" }))
      .toBeVisible();
  });

  it("shows zero when the ready feed has nothing, even if this project's stream still says 1", async () => {
    const c = counts({ active: 3, needsYou: 1 });
    attentionStore.setState({ feed: EMPTY_ATTENTION_FEED, ready: true });
    await render(<CountsHeader {...props(c.selector)} />);
    await expect.element(page.getByText("3 active · 0 need you")).toBeVisible();
  });

  it("falls back to this project's count until the feed's first snapshot, then switches over", async () => {
    const c = counts({ active: 3, needsYou: 1 });
    attentionStore.setState({
      feed: { beta: projectOf("beta", "Beta", ["b", "c"]) },
      ready: false,
    });
    await render(<CountsHeader {...props(c.selector)} />);
    await expect.element(page.getByText("3 active · 1 needs you")).toBeVisible();
    attentionStore.setState({ ready: true });
    await expect.element(page.getByText("3 active · 2 need you")).toBeVisible();
  });
});

describe("CountsHeader way back from another project", () => {
  it("offers no way back while on the built-in project", async () => {
    const c = counts({ active: 1, needsYou: 0 });
    await render(<CountsHeader {...props(c.selector)} />);
    await expect
      .element(page.getByRole("button", { name: "Back to Unsorted" }))
      .not.toBeInTheDocument();
  });

  it("returns to the built-in project from a chosen one with Back to Unsorted", async () => {
    const c = counts({ active: 1, needsYou: 0 });
    selectProject("beta");
    await render(<CountsHeader {...props(c.selector)} />);
    await page.getByRole("button", { name: "Back to Unsorted" }).click();
    expect(projectSelection.getState().projectId).toBe(DEFAULT_PROJECT_ID);
    await expect
      .element(page.getByRole("button", { name: "Back to Unsorted" }))
      .not.toBeInTheDocument();
  });

  it("switches to another project from its chip", async () => {
    const c = counts({ active: 1, needsYou: 0 });
    attentionStore.setState({
      feed: { beta: projectOf("beta", "Beta", ["b"]) },
      ready: true,
    });
    await render(<CountsHeader {...props(c.selector)} />);
    await page.getByRole("button", { name: "Beta: 1 needs you" }).click();
    expect(projectSelection.getState().projectId).toBe("beta");
    await expect.element(page.getByRole("button", { name: "Back to Unsorted" })).toBeVisible();
  });
});
