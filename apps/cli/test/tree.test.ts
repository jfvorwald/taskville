import type { ProjectState } from "@taskville/domain/reducer";
import type { Attention } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { renderStatus, statusJson } from "../src/status.ts";

// A hand-built snapshot covering every rule of the status tree (contracts/cli.md).
const agent = (
  id: string,
  displayName: string,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  sourceId: "adapter:generic",
  sourceAgentId: id,
  displayName,
  kind,
  connection: "connected",
  lastSeenAt: "2026-10-30T10:00:00Z",
  toolCallCount: 0,
  consecutiveToolFailures: 0,
  ...extra,
});
const activity = (agentId: string, name: string, extra: Record<string, unknown> = {}) => ({
  agentId,
  activity: name,
  heuristic: false,
  since: "2026-10-30T10:00:00Z",
  openSessionCount: 1,
  ...extra,
});

const state = {
  projectId: "demo",
  reducerVersion: 1,
  head: 40,
  agents: {
    zed: agent("zed", "Zed", "session"),
    lead: agent("lead", "Ada", "lead", { teamId: "t1" }),
    mate: agent("mate", "Tess", "teammate", { teamId: "t1" }),
    sub: agent("sub", "explorer", "subagent", { parentAgentId: "lead" }),
    done: agent("done", "archivist", "subagent", {
      parentAgentId: "lead",
      finishedAt: "2026-10-30T10:01:00Z",
    }),
    deep: agent("deep", "grep-bot", "subagent", { parentAgentId: "sub" }),
    orphan: agent("orphan", "lost", "subagent", { parentAgentId: "gone" }),
    off: agent("off", "Bea", "session", { connection: "disconnected" }),
  },
  teams: {
    t1: {
      id: "t1",
      leadAgentId: "lead",
      memberAgentIds: ["lead", "mate"],
      startedAt: "2026-10-30T10:00:00Z",
    },
  },
  sessions: {},
  toolCalls: {},
  tasks: {
    "task-1": {
      id: "task-1",
      title: "Add login form",
      status: "running",
      assignedAgentIds: ["zed"],
      relatedTaskIds: [],
      updatedAt: "2026-10-30T10:00:00Z",
    },
  },
  activity: {
    zed: activity("zed", "implementing", { taskId: "task-1" }),
    lead: activity("lead", "dispatching"),
    mate: activity("mate", "testing", { heuristic: true }),
    sub: activity("sub", "researching"),
    off: activity("off", "idle"),
  },
  requests: {
    r1: {
      id: "r1",
      agentId: "lead",
      sessionId: "s1",
      kind: "permission",
      toolName: "Bash",
      answerable: false,
      openedAt: "2026-10-30T10:00:00Z",
      state: "open",
      late: false,
      reason: { text: "Bash wants to run: rm ****", masked: true, truncated: false },
    },
  },
  commands: {},
} as unknown as ProjectState;

const attention: Attention[] = [
  {
    agentId: "lead",
    level: "needs_you",
    kind: "permission",
    reason: { text: "Bash wants to run: rm ****", masked: true, truncated: false },
    since: "2026-10-30T10:00:00Z",
    requestId: "r1",
    heuristic: false,
  },
  {
    agentId: "lead",
    level: "waiting",
    kind: "turn_ended",
    since: "2026-10-30T09:59:00Z",
    heuristic: false,
  },
  {
    agentId: "zed",
    level: "trouble",
    kind: "stop_failure",
    reason: { text: "x".repeat(10), masked: false, truncated: true },
    since: "2026-10-30T10:00:00Z",
    heuristic: false,
  },
  {
    agentId: "off",
    level: "trouble",
    kind: "silent",
    reason: { text: "quiet for 12 min", masked: false, truncated: false },
    since: "2026-10-30T09:48:00Z",
    heuristic: true,
  },
  {
    agentId: "sub",
    level: "waiting",
    kind: "idle_prompt",
    since: "2026-10-30T10:00:00Z",
    heuristic: false,
  },
];

const snapshot = { projectId: "demo", cursor: 40, stateHash: "1:abc", state, attention };

describe("renderStatus", () => {
  it("prints the header and an indented tree, hiding finished subagents", () => {
    expect(renderStatus(snapshot, { projectName: "Demo", all: false })).toBe(
      [
        "Demo · 4 active · 1 needs you · 2 trouble · 2 waiting",
        "Ada (lead) · connected · dispatching · needs you: permission Bash - Bash wants to run: rm **** [masked]",
        "  Tess (teammate) · connected · testing (heuristic)",
        "  explorer (subagent) · connected · researching · waiting",
        "    grep-bot (subagent) · connected · idle",
        "Bea · disconnected · idle · trouble (heuristic): quiet for 12 min",
        "lost (subagent) · connected · idle",
        "Zed · connected · implementing · Add login form · trouble: stop_failure - xxxxxxxxxx [truncated]",
        "",
      ].join("\n"),
    );
  });

  it("shows finished subagents with --all", () => {
    const out = renderStatus(snapshot, { projectName: "Demo", all: true });
    expect(out).toContain("  archivist (subagent) · connected · idle · finished\n");
    expect(out.indexOf("archivist")).toBeLessThan(out.indexOf("explorer"));
  });

  it("prints a line for an empty project", () => {
    const empty = {
      ...snapshot,
      state: { ...state, agents: {}, activity: {} } as unknown as ProjectState,
      attention: [],
    };
    expect(renderStatus(empty, { projectName: "Empty", all: false })).toBe(
      "Empty · 0 active · 0 needs you · 0 trouble · 0 waiting\n(no agents)\n",
    );
  });
});

describe("statusJson", () => {
  it("lists agents sorted by ID, filtered like the tree, with the snapshot's cursor and hash", () => {
    const json = statusJson(snapshot, { all: false });
    expect(json.projectId).toBe("demo");
    expect(json.cursor).toBe(40);
    expect(json.stateHash).toBe("1:abc");
    expect(json.agents.map((a) => a.id)).toEqual([
      "deep",
      "lead",
      "mate",
      "off",
      "orphan",
      "sub",
      "zed",
    ]);
    expect(json.agents.find((a) => a.id === "sub")).toMatchObject({
      kind: "subagent",
      parentAgentId: "lead",
    });
    expect(statusJson(snapshot, { all: true }).agents.map((a) => a.id)).toContain("done");
  });

  it("keeps the attention records of listed agents", () => {
    expect(statusJson(snapshot, { all: false }).attention).toHaveLength(5);
  });
});
