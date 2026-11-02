import { describe, expect, it } from "vitest";
import type { AgentView } from "../../../src/city/agents/index.ts";
import {
  createLabelStore,
  crewLabelEntries,
  labelRows,
} from "../../../src/city/movement/labels.ts";
import { agentListRows } from "../../../src/overlays/agent-list/rows.ts";

// M5.02 round 5 pins: a subagent the crew layer draws has no block agent to tag, so it is listed
// (agent list) but its row carries `kind: "subagent"` and the world labels skip it. A subagent
// that needs you still reads "Needs you" and sorts first in the list.

const placement = { x: 0, y: 0, z: 0, heading: 0 };

function view(id: string, extra: Partial<AgentView> = {}): AgentView {
  return {
    id,
    kind: "subagent",
    displayName: id.toUpperCase(),
    activity: "reviewing",
    placement,
    ...extra,
  };
}

const idle = () => ({ state: "idle" as const, onTheWay: false });

describe("labelRows with a crew set", () => {
  const entries = crewLabelEntries([view("kid"), view("other")]);

  it("marks exactly the ids in the crew set as subagents", () => {
    const rows = labelRows(entries, idle, new Set(), new Set(["kid"]));
    expect(rows.find((r) => r.id === "kid")?.kind).toBe("subagent");
    expect(rows.find((r) => r.id === "other")).not.toHaveProperty("kind");
  });

  it("marks nothing when the crew set is left out", () => {
    const rows = labelRows(entries, idle);
    for (const r of rows) expect(r).not.toHaveProperty("kind");
  });

  it("carries the urgent flag per id, independent of the crew set", () => {
    const rows = labelRows(entries, idle, new Set(["kid"]), new Set(["other"]));
    expect(rows.find((r) => r.id === "kid")).toMatchObject({ urgent: true });
    expect(rows.find((r) => r.id === "kid")).not.toHaveProperty("kind");
    expect(rows.find((r) => r.id === "other")).toMatchObject({ urgent: false, kind: "subagent" });
  });

  it("treats a row that gains or loses the subagent kind as a change worth publishing", () => {
    const store = createLabelStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.set(labelRows(entries, idle));
    expect(notified).toBe(1);
    store.set(labelRows(entries, idle));
    expect(notified).toBe(1);
    store.set(labelRows(entries, idle, new Set(), new Set(["kid"])));
    expect(notified).toBe(2);
  });
});

describe("crewLabelEntries", () => {
  it("names a subagent by its activity when nothing needs attention", () => {
    const [entry] = crewLabelEntries([view("kid")]);
    expect(entry).toMatchObject({ id: "kid", name: "KID", status: "Reviewing" });
  });

  it("leads with the activity and adds the attention text after it", () => {
    const [needs, trouble, waiting] = crewLabelEntries([
      view("a", { attention: { level: "needs_you", kind: "permission" } }),
      view("b", { attention: { level: "trouble", kind: "silent", heuristic: true } }),
      view("c", { attention: { level: "waiting", kind: "turn_ended" } }),
    ]);
    expect(needs?.status).toBe("Reviewing; Needs you");
    expect(trouble?.status).toBe("Reviewing; Possible trouble");
    expect(waiting?.status).toBe("Reviewing; Waiting");
  });

  it("returns one entry per view, in order, anchored on the view's own placement", () => {
    const views = [view("a"), view("b"), view("c")];
    const entries = crewLabelEntries(views);
    expect(entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(entries[1]?.anchor).toBe(views[1]?.placement);
  });

  it("gives an empty list for no subagents", () => {
    expect(crewLabelEntries([])).toEqual([]);
  });
});

describe("the agent list rows of subagents", () => {
  it("lists a subagent with its kind word, and a subagent that needs you reads Needs you, first", () => {
    const entries = crewLabelEntries([
      view("calm", { displayName: "Aaron" }),
      view("stuck", {
        displayName: "Zed",
        attention: { level: "needs_you", kind: "permission" },
      }),
    ]);
    const rows = agentListRows(
      labelRows(entries, idle, new Set(["stuck"]), new Set(["calm", "stuck"])),
    );
    expect(rows.map((r) => r.id)).toEqual(["stuck", "calm"]);
    expect(rows[0]).toMatchObject({ urgent: true, kind: "subagent" });
    expect(rows[0]?.description).toBe("Zed, subagent, Reviewing; Needs you");
    expect(rows[0]?.detail).toMatch(/needs you/i);
    expect(rows[1]).toMatchObject({ urgent: false, kind: "subagent" });
    expect(rows[1]?.description).toBe("Aaron, subagent, Reviewing");
  });
});
