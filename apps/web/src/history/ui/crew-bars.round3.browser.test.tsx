import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BASE, finished, recording, registered } from "./crew-bars.fixture.ts";
import { CrewBars, crewRuns } from "./crew-bars.tsx";

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

  it("says the duration is unknown, never NaN, when a receipt time is unparseable", async () => {
    const view = await render(
      <div style={{ width: 1000 }}>
        <CrewBars
          parentId="p"
          range={{ first: 1, last: 5 }}
          runs={[
            {
              agentId: "c",
              parentId: "p",
              name: "garbled-run",
              startSequence: 1,
              startedAt: Number.NaN,
              finishedSequence: 3,
              finishedAt: BASE,
            },
          ]}
        />
      </div>,
    );
    const bar = page.getByRole("img", { name: /garbled-run/ });
    await expect.element(bar).toHaveAccessibleName(/duration unknown/i);
    await expect.element(bar).not.toHaveAccessibleName(/NaN|Invalid/);
    view.unmount();
  });

  it("reads duration unknown for a start clamped to an earlier finish (round 5)", async () => {
    const runs = crewRuns(
      recording([
        registered("p", "Planner", { kind: "session" }),
        finished("c"), // seq 2: the finish precedes the registration
        registered("c", "clamped-run", { kind: "subagent", parentAgentId: "p" }), // seq 3
        registered("x", "filler", { kind: "session" }),
        registered("y", "filler-two", { kind: "session" }),
      ]),
    );
    expect(runs).toHaveLength(1);
    const view = await render(
      <div style={{ width: 1000 }}>
        <CrewBars parentId="p" range={{ first: 1, last: 5 }} runs={runs} />
      </div>,
    );
    const bar = page.getByRole("img", { name: /clamped-run/ });
    await expect.element(bar).toHaveAccessibleName(/duration unknown/i);
    await expect.element(bar).not.toHaveAccessibleName(/\bran\b|\b0s\b/);
    expect(bar.element().getAttribute("data-state")).toBe("finished");
    const group = page
      .getByRole("group", { name: /subagent|crew/i })
      .element()
      .getBoundingClientRect();
    const rect = bar.element().getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(2);
    expect(rect.left).toBeCloseTo(group.left + 250, -0.5); // finish sequence 2 of 1..5
    expect(rect.right).toBeLessThanOrEqual(group.right + 0.5);
    view.unmount();
  });
});
