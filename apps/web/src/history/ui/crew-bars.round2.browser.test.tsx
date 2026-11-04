import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BASE, finished, recording, registered } from "./crew-bars.fixture.ts";
import { CrewBars, crewRuns } from "./crew-bars.tsx";

describe("run links mirror the domain's recorded links (round 4)", () => {
  const session = registered("p", "Planner", { kind: "session" });
  const recorded = registered("c", "reviewer", { kind: "subagent", parentAgentId: "p" });
  const guess = registered("c", "guessed-name", {
    kind: "subagent",
    parentAgentId: "other",
    heuristic: true,
  });

  it("yields no run for a heuristic-only link", () => {
    expect(crewRuns(recording([session, guess]))).toEqual([]);
  });

  it("keeps a recorded run unchanged when a heuristic registration arrives after it", () => {
    const [run, ...rest] = crewRuns(recording([session, recorded, guess]));
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ agentId: "c", parentId: "p", name: "reviewer", startSequence: 2 });
    expect(run.heuristic).toBeFalsy();
  });

  it("builds the run from the recorded registration when a guess came first", () => {
    const [run, ...rest] = crewRuns(recording([session, guess, recorded]));
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ parentId: "p", name: "reviewer", startSequence: 3 });
    expect(run.heuristic).toBeFalsy();
  });

  it("keeps the link when a later recorded registration omits the parent", () => {
    const [run] = crewRuns(
      recording([session, recorded, registered("c", "reviewer", { kind: "subagent" })]),
    );
    expect(run).toMatchObject({ parentId: "p", startSequence: 2 });
  });

  it("drops the run when a later recorded registration makes the agent a non-subagent", () => {
    expect(
      crewRuns(recording([session, recorded, registered("c", "reviewer", { kind: "session" })])),
    ).toEqual([]);
  });

  it("finishes a run whose agent.finished arrived before its first registration", () => {
    const [run] = crewRuns(recording([session, finished("c"), recorded]));
    expect(run).toMatchObject({ agentId: "c", parentId: "p" });
    expect(run.finishedSequence).toBe(2);
    expect(run.finishedAt).toBe(BASE + 2000);
    expect(run.startSequence).toBe(2); // never after its own finish
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
