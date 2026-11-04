import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BASE, finished, recording, registered } from "./crew-bars.fixture.ts";
import { CrewBars, crewRuns } from "./crew-bars.tsx";

describe("heuristic subagent registrations (roborev 6796 high)", () => {
  it("derives a run flagged heuristic, and a recorded registration clears the flag", () => {
    const guess = recording([
      registered("p", "Planner", { kind: "session" }),
      registered("c", "reviewer", { kind: "subagent", parentAgentId: "p", heuristic: true }),
    ]);
    const [run] = crewRuns(guess);
    expect(run).toMatchObject({ agentId: "c", parentId: "p", startSequence: 2 });
    expect(run.heuristic).toBe(true);

    const confirmed = recording([
      registered("p", "Planner", { kind: "session" }),
      registered("c", "reviewer", { kind: "subagent", parentAgentId: "p", heuristic: true }),
      registered("c", "reviewer", { kind: "subagent", parentAgentId: "p" }),
    ]);
    const [kept] = crewRuns(confirmed);
    expect(kept.startSequence).toBe(2);
    expect(kept.heuristic).toBeFalsy();
  });

  it("renders a heuristic run labeled possibly, and a recorded run unlabeled", async () => {
    const base = {
      parentId: "p",
      startSequence: 1,
      startedAt: BASE,
      finishedSequence: 3,
      finishedAt: BASE + 2000,
    };
    const view = await render(
      <div style={{ width: 1000 }}>
        <CrewBars
          parentId="p"
          range={{ first: 1, last: 5 }}
          runs={[
            { ...base, agentId: "g", name: "guess-run", heuristic: true },
            { ...base, agentId: "r", name: "recorded-run" },
          ]}
        />
      </div>,
    );
    const guess = page.getByRole("img", { name: /guess-run/ });
    await expect.element(guess).toHaveAccessibleName(/possibly/i);
    expect(guess.element().getAttribute("data-heuristic")).toBe("true");
    const recorded = page.getByRole("img", { name: /recorded-run/ });
    await expect.element(recorded).not.toHaveAccessibleName(/possibly/i);
    expect(recorded.element().getAttribute("data-heuristic")).toBeNull();
    view.unmount();
  });
});

describe("child recorded before its parent is known (roborev 6796 medium)", () => {
  it("keeps the child's own start and finish once a later registration links the parent", () => {
    const runs = crewRuns(
      recording([
        registered("p", "Planner", { kind: "session" }),
        registered("c", "reviewer", { kind: "subagent" }), // seq 2: SubagentStart, no parent yet
        finished("c"), // seq 3: finishes before the link arrives
        registered("c", "reviewer", { kind: "subagent", parentAgentId: "p" }), // seq 4
      ]),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      parentId: "p",
      startSequence: 2,
      startedAt: BASE + 2000,
      finishedSequence: 3,
      finishedAt: BASE + 3000,
    });
  });

  it("still draws no run for a subagent that is never linked to a parent", () => {
    expect(
      crewRuns(recording([registered("c", "reviewer", { kind: "subagent" }), finished("c")])),
    ).toEqual([]);
  });
});

describe("minimum width (roborev 6796 medium)", () => {
  it("keeps a running subagent registered at the last sequence visible inside the bounds", async () => {
    const view = await render(
      <div style={{ width: 1000, position: "relative" }}>
        <CrewBars
          parentId="p"
          range={{ first: 1, last: 10 }}
          runs={[
            { agentId: "c", parentId: "p", name: "late-run", startSequence: 10, startedAt: BASE },
          ]}
        />
      </div>,
    );
    const group = page
      .getByRole("group", { name: /subagent|crew/i })
      .element()
      .getBoundingClientRect();
    const bar = page
      .getByRole("img", { name: /late-run/ })
      .element()
      .getBoundingClientRect();
    expect(bar.width).toBeGreaterThanOrEqual(2);
    expect(bar.left).toBeGreaterThanOrEqual(group.left - 0.5);
    expect(bar.right).toBeLessThanOrEqual(group.right + 0.5);
    view.unmount();
  });
});
