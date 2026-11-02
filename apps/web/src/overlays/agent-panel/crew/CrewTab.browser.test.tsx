import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { CrewTab } from "./CrewTab.tsx";
import { crewRows } from "./crewRows.ts";

// M5.08 (ARCHITECTURE.md 2.10 "Crew tab", issue #66): the Crew tab list.
//
// Intended interface (new files in this folder):
//   crewRows({ parentId, agents, activity, results?, nowMs, teams? }): CrewRow[]   ./crewRows.ts
//     agents    Record<string, Agent> (store state.agents); activity Record<string, {activity}>
//     results   Record<agentId, string>: the recorded result summary of a finished agent
//               (agent.finished `summary`; not on the Agent record, so the caller supplies it)
//     nowMs     the store clock (never Date.now())
//   CrewRow = { id, name, status: "active" | "idle" | "finished", activity: string | null,
//               elapsedMs: number | null, elapsedLabel: string, summary: string | null,
//               collapsed: boolean }
//     Rows are the parent's DIRECT children (subagents by parentAgentId, a lead's teammates).
//     Order: unfinished first, then finished; each group by registeredSeq, then id.
//     name = displayName else first 8 chars of id. status: finished when finishedAt is set,
//     else idle when activity is "idle", else active. activity = capitalized words
//     ("handing_off" -> "Handing off"), null when finished. elapsed = shell/facts.ts
//     elapsedMs + formatElapsed (frozen at finishedAt for finished). collapsed === finished.
//     summary = results[id] for a finished row ("not reported" when absent), else null.
//   <CrewTab parentId agents activity results? nowMs teams? onSelect(id) onHover(id | null) />
//     data-testid="crew-list" (role=list) holding one data-testid="crew-row" per row with
//     data-agent-id, data-status, data-collapsed. Inside a row: a <button> named by the agent
//     name (click -> onSelect(id); pointer enter -> onHover(id), leave -> onHover(null)),
//     crew-row-dot, crew-row-activity (absent when finished), crew-row-elapsed,
//     crew-row-summary (finished rows only). Empty crew: data-testid="crew-empty".

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const mk = (id: string, over: Record<string, unknown>) => ({
  id,
  sourceId: "claude-code",
  registered: true,
  connection: "connected",
  firstSeenAt: iso(-125_000),
  lastSeenAt: iso(0),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
  ...over,
});
const agents = {
  L: mk("L", { kind: "lead", teamId: "T", displayName: "Lead", registeredSeq: 1 }),
  a: mk("a", { kind: "subagent", parentAgentId: "L", displayName: "Scout", registeredSeq: 3 }),
  b: mk("b", {
    kind: "subagent",
    parentAgentId: "L",
    displayName: "Tester",
    registeredSeq: 2,
    firstSeenAt: iso(-45_000),
  }),
  c: mk("c", {
    kind: "subagent",
    parentAgentId: "L",
    displayName: "Reviewer",
    registeredSeq: 1,
    firstSeenAt: iso(-600_000),
    finishedAt: iso(-300_000),
  }),
  other: mk("other", { kind: "subagent", parentAgentId: "elsewhere", registeredSeq: 4 }),
} as never;
const act = (name: string) => ({ activity: name });
const activity = { a: act("handing_off"), b: act("idle"), c: act("idle") } as never;
const results = { c: "Found 2 issues in the parser" };

describe("crewRows", () => {
  const rows = crewRows({ parentId: "L", agents, activity, results, nowMs: NOW });

  it("lists only the parent's direct children, unfinished first then finished", () => {
    expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("derives status, activity and elapsed from the record and the store clock", () => {
    const [b, a] = rows;
    expect(b).toMatchObject({
      name: "Tester",
      status: "idle",
      activity: "Idle",
      elapsedMs: 45_000,
      elapsedLabel: "45s",
      collapsed: false,
      summary: null,
    });
    expect(a).toMatchObject({
      status: "active",
      activity: "Handing off",
      elapsedLabel: "2m 5s",
    });
  });

  it("collapses a finished child with its result summary and a frozen elapsed time", () => {
    expect(rows[2]).toMatchObject({
      id: "c",
      status: "finished",
      collapsed: true,
      activity: null,
      summary: "Found 2 issues in the parser",
      elapsedLabel: "5m 0s",
    });
    const later = crewRows({ parentId: "L", agents, activity, results, nowMs: NOW + 60_000 });
    expect(later[2]?.elapsedLabel).toBe("5m 0s");
    expect(later[0]?.elapsedLabel).toBe("1m 45s");
  });

  it("says 'not reported' when a finished child has no recorded summary", () => {
    const r = crewRows({ parentId: "L", agents, activity, nowMs: NOW });
    expect(r[2]?.summary).toBe("not reported");
  });

  it("is empty for a parent without children", () => {
    expect(crewRows({ parentId: "a", agents, activity, nowMs: NOW })).toEqual([]);
  });
});

function setup(over: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  const onHover = vi.fn();
  const screen = render(
    <CrewTab
      parentId="L"
      agents={agents}
      activity={activity}
      results={results}
      nowMs={NOW}
      onSelect={onSelect}
      onHover={onHover}
      {...over}
    />,
  );
  return { onSelect, onHover, screen };
}

describe("CrewTab", () => {
  it("renders one row per child in order with status, activity and elapsed", async () => {
    setup();
    await expect.element(page.getByTestId("crew-list")).toBeVisible();
    const rows = page.getByTestId("crew-row").elements();
    expect(rows.map((e) => e.getAttribute("data-agent-id"))).toEqual(["b", "a", "c"]);
    expect(rows.map((e) => e.getAttribute("data-status"))).toEqual(["idle", "active", "finished"]);
    await expect.element(page.getByText("Handing off")).toBeVisible();
    await expect.element(page.getByText("2m 5s")).toBeVisible();
  });

  it("shows a finished child collapsed: summary, no activity line", async () => {
    setup();
    const finished = page.getByTestId("crew-row").nth(2);
    await expect.element(finished).toHaveAttribute("data-collapsed", "true");
    await expect
      .element(finished.getByTestId("crew-row-summary"))
      .toHaveTextContent("Found 2 issues in the parser");
    expect(finished.getByTestId("crew-row-activity").elements()).toHaveLength(0);
    await expect
      .element(page.getByTestId("crew-row").nth(0).getByTestId("crew-row-summary"))
      .not.toBeInTheDocument();
  });

  it("clicking a row selects that agent", async () => {
    const { onSelect } = setup();
    await page.getByRole("button", { name: "Scout" }).click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("hovering a row reports the hovered agent, leaving clears it", async () => {
    const { onHover } = setup();
    const button = page.getByRole("button", { name: "Tester" });
    await button.hover();
    expect(onHover).toHaveBeenLastCalledWith("b");
    await page.getByRole("button", { name: "Scout" }).hover();
    expect(onHover).toHaveBeenLastCalledWith("a");
    await userEvent.unhover(page.getByRole("button", { name: "Scout" }));
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("shows an empty state when the parent has no crew", async () => {
    setup({ parentId: "a" });
    await expect.element(page.getByTestId("crew-empty")).toBeVisible();
  });
});
