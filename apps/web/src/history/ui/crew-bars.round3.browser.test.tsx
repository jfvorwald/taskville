import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BASE, recording, registered } from "./crew-bars.fixture.ts";
import { CrewBars, crewRuns } from "./crew-bars.tsx";

describe("inherited links stay heuristic (roborev 6823 high)", () => {
  const guess = registered("c", "reviewer", {
    kind: "subagent",
    parentAgentId: "p",
    heuristic: true,
  });
  const plain = registered("c", "reviewer", { kind: "subagent" });
  const named = registered("c", "reviewer", { kind: "subagent", parentAgentId: "p" });

  it("keeps heuristic when a recorded registration names no parent", () => {
    const [run] = crewRuns(
      recording([registered("p", "Planner", { kind: "session" }), guess, plain]),
    );
    expect(run).toMatchObject({ agentId: "c", parentId: "p", startSequence: 2 });
    expect(run.heuristic).toBe(true);
  });

  it("clears heuristic only when a recorded registration itself names the parent", () => {
    const [run] = crewRuns(
      recording([registered("p", "Planner", { kind: "session" }), guess, plain, named]),
    );
    expect(run).toMatchObject({ parentId: "p", startSequence: 2 });
    expect(run.heuristic).toBeFalsy();
  });
});

describe("negative durations (roborev 6823 medium)", () => {
  it("says the duration is unknown when the receipt clock moved backward", async () => {
    const view = await render(
      <div style={{ width: 1000 }}>
        <CrewBars
          parentId="p"
          range={{ first: 1, last: 5 }}
          runs={[
            {
              agentId: "c",
              parentId: "p",
              name: "skewed-run",
              startSequence: 1,
              startedAt: BASE + 5000,
              finishedSequence: 3,
              finishedAt: BASE + 2000,
            },
          ]}
        />
      </div>,
    );
    const bar = page.getByRole("img", { name: /skewed-run/ });
    await expect.element(bar).toHaveAccessibleName(/duration unknown/i);
    await expect.element(bar).not.toHaveAccessibleName(/\bran\b/);
    await expect.element(bar).not.toHaveAccessibleName(/-\d/);
    expect(bar.element().getAttribute("data-state")).toBe("finished");
    view.unmount();
  });
});
