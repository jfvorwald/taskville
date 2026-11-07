import { describe, expect, it } from "vitest";
import type { MovementLabel } from "../../../src/city/movement/labels.ts";
import { agentListRows } from "../../../src/overlays/agent-list/rows.ts";

// M9.04: `agentListRows(labels, breakTime = true)`. A Waiting row whose label has `onBreak: true`
// speaks "Name, Waiting, on break" (detail "Waiting, on break"). With the Break time setting off
// (second argument false), or for any status other than Waiting, there is no note.

const label = (
  over: Partial<MovementLabel> & Pick<MovementLabel, "id" | "name">,
): MovementLabel => ({
  status: "Waiting",
  onTheWay: false,
  state: "idle",
  urgent: false,
  ...over,
});

describe("agentListRows on break", () => {
  it("adds the on break note to a waiting agent on break", () => {
    const [row] = agentListRows([label({ id: "a1", name: "Ada", onBreak: true })]);
    expect(row?.description).toBe("Ada, Waiting, on break");
    expect(row?.detail).toBe("Waiting, on break");
  });

  it("reads exactly as today when the agent is not on break", () => {
    const [row] = agentListRows([label({ id: "a1", name: "Ada" })]);
    expect(row?.description).toBe("Ada, Waiting");
    expect(row?.detail).toBe("Waiting");
  });

  it("drops the note when the Break time setting is off", () => {
    const [row] = agentListRows([label({ id: "a1", name: "Ada", onBreak: true })], false);
    expect(row?.description).toBe("Ada, Waiting");
    expect(row?.detail).toBe("Waiting");
  });

  it("never notes needs-you, trouble or working rows, even with a stale flag", () => {
    const rows = agentListRows([
      label({ id: "n", name: "Nia", status: "Needs you", urgent: true, onBreak: true }),
      label({ id: "t", name: "Tom", status: "Trouble: quiet for 12 min", onBreak: true }),
      label({ id: "w", name: "Wes", status: "Testing", state: "working", onBreak: true }),
    ]);
    for (const row of rows) {
      expect(row.description).not.toMatch(/on break/i);
      expect(row.detail).not.toMatch(/on break/i);
    }
    expect(rows.find((r) => r.id === "w")?.description).toBe("Wes, Testing");
  });

  it("keeps 'on the way' after the break note when both apply", () => {
    const [row] = agentListRows([label({ id: "a1", name: "Ada", onBreak: true, onTheWay: true })]);
    expect(row?.detail).toBe("Waiting, on break, on the way");
  });
});
