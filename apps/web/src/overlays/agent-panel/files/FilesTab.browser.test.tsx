import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import { FilesTab } from "./FilesTab.tsx";
import recorded from "./recorded-feed.fixture.json";

// M5.07: controlled presentation over the EXISTING M5.01 feed, no new endpoint.
// Public seam: FilesTab({ agentId, frames: readonly { id: number; data: ToolCallFrame }[],
//                       evidence?: Readonly<Record<string, EvidenceResponse>> }).
// `id` is the SSE ingest sequence; data is unchanged M5.01 toolcall data. Agent IDs from the
// Claude adapter include the session identity. Never group agents by path, name or role.
// The caller supplies the selected feed and any bodies already read from /v1/evidence/:id.
// No new transport, editor links, syntax highlighter or privacy settings are required here.
// Markup: file rows are buttons containing the path and edit count, data-testid="file-row",
// data-file-path and data-edit-count. Detail data-testid="file-edits", data-file-path, contains
// one data-tool-call-id element per Edit/Write call, in first-recorded ingest order.
// Count only succeeded Edit/Write calls once per toolCallId per file; reads are touches, not
// edits. Tied timestamps use ingest order, never path order or wall clock. A later finish or
// redelivered frame must not move a file as though it were a new edit.
// Evidence is text, not HTML. Missing fields/bodies say "not reported". Never reconstruct lines.
// Fixture provenance is checked in test/overlays/agent-panel/files/recorded-feed.test.ts.

type Frame = { id: number; data: ToolCallFrame };
const frames: Frame[] = recorded.frames as Frame[];
const evidence = recorded.evidence as Record<string, EvidenceResponse>;
const SESSION = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const A = `${SESSION}:afdf84bea07a9064c`;
const B = `${SESSION}:a0b4668e13e056653`;
const NOTES = "/tmp/spike-s2/proj/notes.txt";
const HELLO = "/tmp/spike-s2/proj/hello.txt";
const EDIT = "toolu_01BFbfwiNzH1amZ3p2p6TGUm";
const WRITE = "toolu_012456Qp8BNCL1oE2LoMK9x5";
const row = (path: string) => page.getByTestId("file-row").filter({ hasText: path });
const detail = () => page.getByTestId("file-edits");
const rows = () =>
  page
    .getByTestId("file-row")
    .elements()
    .map((e) => [e.getAttribute("data-file-path"), e.getAttribute("data-edit-count")]);
const detailIds = () => detail().element().querySelectorAll("[data-tool-call-id]");
const ids = () => Array.from(detailIds(), (e) => e.getAttribute("data-tool-call-id"));

// Explicit synthetic feed variants add cases the recording does not contain. Keep the wire shape.
function editFrame(
  id: number,
  toolCallId: string,
  path: string,
  over: Partial<ToolCallFrame> = {},
): Frame {
  const original = frames.find((f) => f.data.toolCallId === EDIT && f.data.phase === "succeeded");
  if (!original) throw new Error("recorded Edit missing");
  const data = { ...original.data, toolCallId, filePaths: [path], ...over };
  if (data.phase === "running") {
    delete data.finishedAt;
    delete data.durationMs;
    data.evidence = { ...data.evidence, output: null };
  }
  return { id, data };
}

function shellProps(selectedId: string): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_key, fallback) => fallback, set: () => {} },
  };
}

describe("M5.07 Files tab", () => {
  it("mounts in the real shell Files slot and separates sibling agents from the fixture feed", async () => {
    const store = createDataStore();
    store.getState().applySnapshotState({
      ...initialState("spike"),
      agents: Object.fromEntries(
        [A, B].map((id) => [
          id,
          {
            id,
            sourceId: "claude-code",
            kind: "subagent" as const,
            registered: true,
            connection: "connected" as const,
            toolCallCount: 0,
            consecutiveToolFailures: 0,
            firstSeenAt: "2026-10-31T12:00:00Z",
            lastSeenAt: "2026-10-31T12:01:00Z",
          },
        ]),
      ),
    });
    const tab: ComponentProps<typeof AgentPanel>["renderTab"] = (name, agentId) =>
      name === "files" ? <FilesTab agentId={agentId} frames={frames} evidence={evidence} /> : null;
    const view = await render(<AgentPanel {...shellProps(A)} store={store} renderTab={tab} />);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect.element(row(NOTES)).toBeVisible();
    expect(rows()).toEqual([[NOTES, "1"]]);
    await row(NOTES).click();
    await expect.element(detail()).toHaveTextContent("beta");
    await expect.element(detail()).toHaveTextContent("BETA");
    expect(ids()).toEqual([EDIT]);
    await view.rerender(<AgentPanel {...shellProps(B)} store={store} renderTab={tab} />);
    await expect.element(row(HELLO)).toBeVisible();
    expect(rows()).toEqual([[HELLO, "1"]]);
    expect(detail().elements()).toHaveLength(0);
    await row(HELLO).click();
    await expect.element(detail()).toHaveTextContent("hello from B");
    expect(ids()).toEqual([WRITE]);
  });

  it("orders files newest first using the first record of a call, with stable timestamp ties", async () => {
    // All copies deliberately have identical recorded times. Paths run opposite lexical order.
    const feed = [
      editFrame(40, "first", "z.ts"),
      editFrame(41, "second", "a.ts"),
      editFrame(42, "third", "m.ts"),
      editFrame(90, "first", "z.ts"),
    ];
    const view = await render(<FilesTab agentId={A} frames={feed} />);
    await expect.element(row("m.ts")).toBeVisible();
    expect(rows()).toEqual([
      ["m.ts", "1"],
      ["a.ts", "1"],
      ["z.ts", "1"],
    ]);
    await view.rerender(<FilesTab agentId={A} frames={[...feed, ...feed]} />);
    expect(rows()).toEqual([
      ["m.ts", "1"],
      ["a.ts", "1"],
      ["z.ts", "1"],
    ]);
  });

  it("counts actual edits without inflating running/finish updates, repeated paths or reads", async () => {
    const first = editFrame(40, "one", NOTES, { filePaths: [NOTES, NOTES] });
    const feed = [
      ...frames,
      { ...first, id: 39, data: { ...first.data, phase: "running" as const } },
      first,
      first,
      editFrame(41, "failed", NOTES, { phase: "failed" }),
      editFrame(42, "pending", NOTES, { phase: "running" }),
      editFrame(43, "read", "read-only.ts", { toolName: "Read" }),
    ];
    await render(<FilesTab agentId={A} frames={feed} evidence={evidence} />);
    await expect.element(row(NOTES)).toHaveAttribute("data-edit-count", "2");
    await expect.element(row("read-only.ts")).toHaveAttribute("data-edit-count", "0");
  });

  it("filters details to the clicked file in recorded order rather than timestamp or finish order", async () => {
    const feed = [
      editFrame(40, "one", NOTES, { phase: "running", startedAt: "2026-11-01T12:00:02Z" }),
      editFrame(41, "other", HELLO),
      editFrame(42, "two", NOTES, { startedAt: "2026-11-01T12:00:01Z" }),
      editFrame(43, "one", NOTES, { startedAt: "2026-11-01T12:00:02Z" }),
    ];
    await render(<FilesTab agentId={A} frames={feed} evidence={evidence} />);
    await row(NOTES).click();
    await expect.element(detail()).toHaveAttribute("data-file-path", NOTES);
    expect(ids()).toEqual(["one", "two"]);
    await row(HELLO).click();
    await expect.element(detail()).toHaveAttribute("data-file-path", HELLO);
    expect(ids()).toEqual(["other"]);
  });

  it("does not carry files or open detail into a different session with the same paths", async () => {
    const otherSession = "claude-code:another-session:afdf84bea07a9064c";
    const feed = [...frames, editFrame(50, "other-session-edit", NOTES, { agentId: otherSession })];
    const view = await render(<FilesTab agentId={A} frames={feed} evidence={evidence} />);
    await row(NOTES).click();
    expect(ids()).toEqual([EDIT]);
    await view.rerender(<FilesTab agentId={otherSession} frames={feed} evidence={evidence} />);
    await expect.element(row(NOTES)).toHaveAttribute("data-edit-count", "1");
    expect(detail().elements()).toHaveLength(0);
    await row(NOTES).click();
    expect(ids()).toEqual(["other-session-edit"]);
  });

  it("shows an honest empty state and clears detail when the selected feed is replaced", async () => {
    const view = await render(<FilesTab agentId={A} frames={frames} evidence={evidence} />);
    await row(NOTES).click();
    await view.rerender(<FilesTab agentId={A} frames={[]} />);
    await expect.element(page.getByText(/no files.*reported/i)).toBeVisible();
    expect(rows()).toEqual([]);
    expect(detail().elements()).toHaveLength(0);
  });

  it("does not invent a path or code when the report omitted them or evidence was evicted", async () => {
    const absentPath = editFrame(40, "no-path", NOTES, { filePaths: [] });
    const missing = editFrame(41, "no-body", NOTES, { evidence: { input: null, output: null } });
    const evicted = editFrame(42, "evicted", HELLO, {
      evidence: { input: { id: "gone", status: "evicted" }, output: null },
    });
    await render(<FilesTab agentId={A} frames={[absentPath, missing, evicted]} />);
    expect(
      rows()
        .map(([path]) => path)
        .sort(),
    ).toEqual([HELLO, NOTES].sort());
    await row(NOTES).click();
    await expect.poll(() => detail().element().textContent).toMatch(/not reported/i);
    expect(ids()).toEqual(["no-body"]);
    await row(HELLO).click();
    await expect
      .poll(() => detail().element().textContent)
      .toMatch(/evicted|not reported|unavailable/i);
    expect(ids()).toEqual(["evicted"]);
    expect(detail().element().querySelectorAll("[data-line-number]")).toHaveLength(0);
  });
});
