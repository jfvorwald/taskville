import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BASE } from "./crew-bars.fixture.ts";
import { CrewBars } from "./crew-bars.tsx";

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
});
