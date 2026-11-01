import { describe, expect, it } from "vitest";
import type { MovementLabel } from "../../../src/city/movement/labels.ts";
import { agentListRows } from "../../../src/overlays/agent-list/rows.ts";

// M3.14: the accessible agent list mirrors the scene. Its rows come from the same label rows the
// world labels draw, so a screen reader hears what a sighted user reads.

const label = (
  over: Partial<MovementLabel> & Pick<MovementLabel, "id" | "name">,
): MovementLabel => ({
  status: "Idle",
  onTheWay: false,
  state: "idle",
  urgent: false,
  ...over,
});

describe("agentListRows", () => {
  it("is empty when there are no agents", () => {
    expect(agentListRows([])).toEqual([]);
  });

  it("keeps the id and speaks name, recorded status and the on-the-way mark", () => {
    const rows = agentListRows([
      label({ id: "a1", name: "Ada", status: "Testing", onTheWay: true, state: "walking" }),
      label({ id: "a2", name: "Brook", status: "Implementing" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(rows[0]?.description).toBe("Ada, Testing, on the way");
    expect(rows[1]?.description).toBe("Brook, Implementing");
  });

  it("lists agents that need you first, then the rest by name", () => {
    const rows = agentListRows([
      label({ id: "c", name: "Cyd" }),
      label({ id: "z", name: "Zed", status: "Needs you", urgent: true }),
      label({ id: "a", name: "Ada" }),
      label({ id: "m", name: "Max", status: "Needs you", urgent: true }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Max", "Zed", "Ada", "Cyd"]);
    expect(rows.map((r) => r.urgent)).toEqual([true, true, false, false]);
  });

  it("does not change the input", () => {
    const input = [label({ id: "b", name: "Brook" }), label({ id: "a", name: "Ada" })];
    const before = input.map((l) => l.id);
    agentListRows(input);
    expect(input.map((l) => l.id)).toEqual(before);
  });
});
