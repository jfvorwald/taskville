import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AGENT, type CallSpec, constrained, paint, seedStore } from "./liveKit.tsx";

// M10.04 (#489) item 2, red first. A pending permission request records its tool name, not a
// call. Contract: whenever no single running call of that tool can be identified, the request is
// its own last entry "Needs you: <Tool>" and no call is marked. That includes a tool with no
// running call at all (the M10.02 limitation: it showed no entry). One running call still takes
// the node itself (covered in LiveLogbookReview.browser.test.tsx).

const entries = () => page.getByTestId("logbook-entry");
const states = () =>
  entries()
    .elements()
    .map((el) => ({
      state: el.querySelector("[data-testid=entry-status]")?.getAttribute("data-state"),
      sentence: el.querySelector("[data-testid=entry-sentence]")?.textContent?.trim(),
    }));

describe("a pending permission request with no identifiable running call", () => {
  const SINCE = "2026-11-08T12:00:00Z";
  function pending(tool: string) {
    const store = seedStore();
    const state = store.getState().state;
    if (!state) throw new Error("seed state absent");
    store.getState().applySnapshotState({
      ...state,
      sessions: {
        "nm-session": {
          id: "nm-session",
          agentId: AGENT,
          sourceId: "claude-code",
          provenance: "live",
          firstSeenAt: SINCE,
          startedAt: SINCE,
          startSeq: 1,
          workingDirectory: "/r",
          activity: { activity: "unknown", heuristic: false, since: SINCE },
        },
      },
      requests: {
        "nm-request": {
          id: "nm-request",
          agentId: AGENT,
          sessionId: "nm-session",
          kind: "permission",
          toolName: tool,
          answerable: true,
          openedAt: SINCE,
          state: "open",
          late: false,
          mergedRequestIds: [],
        },
      },
    });
    store.setState({
      attention: [
        {
          agentId: AGENT,
          level: "needs_you",
          kind: "permission",
          since: SINCE,
          requestId: "nm-request",
          heuristic: false,
        },
      ],
    });
    return store;
  }
  async function showPending(tool: string, specs: readonly CallSpec[]) {
    await render(constrained(specs, pending(tool), 1200));
    await paint();
    await expect.poll(() => entries().elements().length).toBeGreaterThan(0);
  }
  const done = (id: string, tool = "Bash"): CallSpec => ({
    id,
    tool,
    input: tool === "Bash" ? { command: `run ${id}` } : { file_path: `/r/${id}.ts` },
    filePaths: tool === "Bash" ? [] : [`/r/${id}.ts`],
    output: tool === "Bash" ? { stdout: "", stderr: "", interrupted: false } : undefined,
    durationMs: 4,
  });

  it("adds a last Needs you entry when the tool has no running call", async () => {
    await showPending("Bash", [done("nm-a"), done("nm-b")]);
    const all = states();
    expect(all.filter((s) => s.state === "needs-you")).toEqual([
      { state: "needs-you", sentence: "Needs you: Bash" },
    ]);
    expect(all.at(-1)?.sentence).toBe("Needs you: Bash");
    expect(all.filter((s) => s.state === "running")).toHaveLength(0);
  });

  it("adds it when the only running call is of a different tool", async () => {
    await showPending("Bash", [
      done("nm-c"),
      { id: "nm-run", tool: "Edit", input: { file_path: "/r/x.ts" }, phase: "running" },
    ]);
    const all = states();
    expect(all.filter((s) => s.state === "needs-you")).toEqual([
      { state: "needs-you", sentence: "Needs you: Bash" },
    ]);
    expect(all.filter((s) => s.state === "running")).toHaveLength(1);
  });
});
