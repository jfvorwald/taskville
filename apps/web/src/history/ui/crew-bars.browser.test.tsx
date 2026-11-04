import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import golden from "../../../../../packages/adapters/test/claude-code/crew/golden/subagent-parallel.json";
import {
  type StoredEnvelope,
  storedEnvelopeSchema,
} from "../../../../../packages/protocol/src/index.ts";
import { CrewBars, type CrewRun, crewRuns } from "./crew-bars.tsx";

// Crew fixture: the S-2 parallel subagent stream (fixtures/claude-code/subagent/parallel.jsonl)
// as mapped by the Claude Code adapter (golden file). Two subagents of one session, both
// registered, linked to the session, and finished. Ingest sequences are 1-based in stream
// order, one second apart, so durations are exact.
const BASE = Date.parse("2026-10-30T12:00:00Z");
const SESSION = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const A = `${SESSION}:afdf84bea07a9064c`;
const B = `${SESSION}:a0b4668e13e056653`;

function stored(skipFinishOf?: string): StoredEnvelope[] {
  const input = (golden as Array<{ events: Array<Record<string, unknown>> }>)
    .flatMap((hook) => hook.events)
    .filter((event) => !(event.type === "agent.finished" && event.agentId === skipFinishOf));
  return input.map((event, index) =>
    storedEnvelopeSchema.parse({
      ...event,
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ingestSequence: index + 1,
      evidenceIds: [],
      receivedAt: new Date(BASE + (index + 1) * 1000).toISOString(),
    }),
  );
}

describe("crewRuns", () => {
  it("derives one closed run per subagent, linked to its parent, from recorded events", () => {
    const runs = crewRuns(stored());
    expect(runs.map((run) => run.agentId).sort()).toEqual([A, B].sort());
    for (const run of runs) {
      expect(run.parentId).toBe(SESSION);
      expect(run.name).toBe("general-purpose");
      expect(run.finishedSequence).toBeGreaterThan(run.startSequence);
      expect(run.finishedAt).toBeGreaterThan(run.startedAt);
    }
  });

  it("leaves a subagent with no recorded finish open", () => {
    const runs = crewRuns(stored(B));
    expect(runs.find((run) => run.agentId === B)?.finishedSequence).toBeUndefined();
    expect(runs.find((run) => run.agentId === B)?.finishedAt).toBeUndefined();
    expect(runs.find((run) => run.agentId === A)?.finishedSequence).toBeDefined();
  });
});

const WIDTH = 1000;
async function mount(runs: readonly CrewRun[], last: number, parentId = SESSION) {
  const view = await render(
    <div style={{ width: WIDTH, position: "relative" }}>
      <CrewBars runs={runs} parentId={parentId} range={{ first: 1, last }} />
    </div>,
  );
  return view;
}
const bars = () => page.getByRole("img", { name: /general-purpose/ });
const box = (element: Element) => element.getBoundingClientRect();

describe("CrewBars", () => {
  it("draws one bar per subagent run under its parent, placed by sequence on the scale", async () => {
    const log = stored();
    const runs = crewRuns(log);
    const last = log.length;
    const decoy: CrewRun = {
      agentId: "other:sub",
      parentId: "other-parent",
      name: "general-purpose",
      startSequence: 2,
      startedAt: BASE,
      finishedSequence: 3,
      finishedAt: BASE + 1000,
    };
    const view = await mount([...runs, decoy], last);
    const group = page.getByRole("group", { name: /subagent|crew/i });
    await expect.element(group).toBeVisible();
    expect(bars().elements()).toHaveLength(2);

    const frame = box(group.element());
    const sorted = [...runs].sort((x, y) => x.startSequence - y.startSequence);
    const elements = bars()
      .elements()
      .sort((x, y) => box(x).left - box(y).left);
    sorted.forEach((run, index) => {
      const rect = box(elements[index]);
      const left = frame.left + ((run.startSequence - 1) / (last - 1)) * frame.width;
      const right = frame.left + (((run.finishedSequence ?? last) - 1) / (last - 1)) * frame.width;
      expect(rect.left).toBeCloseTo(left, -0.5);
      expect(rect.right).toBeCloseTo(right, -0.5);
    });
    view.unmount();
  });

  it("draws a finished subagent closed and labels name, start and duration", async () => {
    const log = stored();
    const run = crewRuns(log).find((r) => r.agentId === A);
    if (!run) throw new Error("fixture lost subagent A");
    const view = await mount([run], log.length);
    const bar = bars();
    await expect.element(bar).toBeVisible();
    const seconds = Math.round(((run.finishedAt ?? 0) - run.startedAt) / 1000);
    await expect.element(bar).toHaveAccessibleName(/general-purpose/);
    await expect
      .element(bar)
      .toHaveAccessibleName(
        new RegExp(new Date(run.startedAt).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    await expect.element(bar).toHaveAccessibleName(new RegExp(`\\bran ${seconds}s\\b`));
    await expect.element(bar).not.toHaveAccessibleName(/running/i);
    expect(bar.element().getAttribute("data-state")).toBe("finished");
    view.unmount();
  });

  it("draws a still-running subagent open-ended to the end of the scale", async () => {
    const log = stored(B);
    const run = crewRuns(log).find((r) => r.agentId === B);
    if (!run) throw new Error("fixture lost subagent B");
    const view = await mount([run], log.length);
    const bar = bars();
    await expect.element(bar).toBeVisible();
    await expect.element(bar).toHaveAccessibleName(/general-purpose/);
    await expect.element(bar).toHaveAccessibleName(/\brunning\b/i);
    await expect.element(bar).not.toHaveAccessibleName(/\bran \d/);
    expect(bar.element().getAttribute("data-state")).toBe("running");
    const group = box(page.getByRole("group", { name: /subagent|crew/i }).element());
    expect(box(bar.element()).right).toBeCloseTo(group.right, -0.5);
    view.unmount();
  });

  it("renders nothing for a parent with no subagent runs", async () => {
    const view = await mount(crewRuns(stored()), stored().length, "nobody");
    expect(bars().elements()).toHaveLength(0);
    view.unmount();
  });
});
