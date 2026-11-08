import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Attention } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import "../../../styles/tokens.css";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { getSettingsStore } from "../../settings/store.ts";
import { FilesTab } from "../files/FilesTab.tsx";
import recorded from "../files/recorded-feed.fixture.json";
import { AgentPanel } from "./AgentPanel.tsx";

// M10.03 review-fix red: header facts, header file, focus (crumb activation and focus rings in the
// tab slot) and the urgent status color.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const mk = (id: string, over: Record<string, unknown>) => ({
  id,
  sourceId: "claude-code",
  registered: true,
  connection: "connected",
  firstSeenAt: iso(-125_000),
  lastSeenAt: iso(0),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
  ...over,
});
const LONG_ROLE = "a very long recorded role name for a subagent";
const FILE = "/work/project/src/components/deeply/nested/folders/for/the/test/FileName.tsx";
const SESSION = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const A = `${SESSION}:afdf84bea07a9064c`;

function makeStore(over: { attention?: Attention[]; toolCalls?: Record<string, unknown> } = {}) {
  const s = createDataStore({ now: () => NOW });
  s.setState({
    projectId: "proj-1",
    connection: "live",
    attention: over.attention ?? [],
    state: {
      agents: {
        L: mk("L", { kind: "lead", displayName: "Lead", registeredSeq: 1 }),
        c: mk("c", {
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Child",
          registeredSeq: 2,
        }),
        S: mk("S", { kind: "session", displayName: "Solo", role: LONG_ROLE, registeredSeq: 3 }),
        [A]: mk(A, { kind: "session", displayName: "Filer", registeredSeq: 4 }),
      },
      teams: {},
      activity: {
        S: { agentId: "S", activity: "idle", heuristic: false, since: iso(-1000) },
      },
      toolCalls: over.toolCalls ?? {},
    } as unknown as NonNullable<ReturnType<typeof s.getState>["state"]>,
  });
  return s;
}

function props(selectedId: string, select: (id: string | null) => void = () => {}): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

const panel = () => page.getByTestId("agent-panel").element() as HTMLElement;
const part = (id: string) => page.getByTestId(id).element() as HTMLElement;
const inside = (inner: DOMRect, outer: DOMRect) =>
  inner.width > 0 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;

afterEach(() => getSettingsStore().set("breakTime", true));

describe("header facts at a narrow panel", () => {
  // Panel width is the frame minus 32 px of margin: a 330 px frame gives a 298 px panel.
  const narrow = (children: React.ReactNode) => <div style={{ width: 330 }}>{children}</div>;
  const needsYou: Attention = {
    agentId: "S",
    level: "needs_you",
    kind: "permission",
    since: iso(-5000),
    requestId: "r1",
    heuristic: false,
  };

  function expectKept(ids: string[]) {
    const box = panel().getBoundingClientRect();
    for (const id of ids) {
      const item = part(id);
      expect(inside(item.getBoundingClientRect(), box), `${id} is inside the panel`).toBe(true);
      const parent = item.parentElement as HTMLElement;
      expect(inside(item.getBoundingClientRect(), parent.getBoundingClientRect()), id).toBe(true);
      // An item that is too long shrinks with an ellipsis; it is never cut off silently.
      expect(
        item.scrollWidth <= item.clientWidth + 1 ||
          getComputedStyle(item).textOverflow === "ellipsis",
        `${id} shrinks with an ellipsis`,
      ).toBe(true);
    }
  }

  it("keeps Needs you and the elapsed time visible next to a long role", async () => {
    await render(
      narrow(<AgentPanel {...props("S")} store={makeStore({ attention: [needsYou] })} />),
    );
    await expect.element(page.getByTestId("agent-panel-status")).toHaveTextContent("Needs you");
    expectKept(["agent-panel-type", "agent-panel-status", "agent-panel-elapsed"]);
  });

  it("keeps the status and the break note visible next to a long role", async () => {
    getSettingsStore().set("breakTime", true);
    await render(
      narrow(<AgentPanel {...props("S")} store={makeStore()} onBreak={new Set(["S"])} />),
    );
    await expect.element(page.getByTestId("agent-panel-on-break")).toBeVisible();
    expectKept([
      "agent-panel-type",
      "agent-panel-status",
      "agent-panel-on-break",
      "agent-panel-elapsed",
    ]);
  });
});

describe("urgent status color", () => {
  it("differs from the muted facts even when --tv-needs-you is unset", async () => {
    const attention: Attention = {
      agentId: "S",
      level: "needs_you",
      kind: "permission",
      since: iso(-5000),
      requestId: "r1",
      heuristic: false,
    };
    await render(
      <div style={{ "--tv-needs-you": "initial" } as React.CSSProperties}>
        <AgentPanel {...props("S")} store={makeStore({ attention: [attention] })} />
      </div>,
    );
    const status = getComputedStyle(part("agent-panel-status")).color;
    const muted = getComputedStyle(part("agent-panel-type")).color;
    expect(status).not.toBe(muted);
  });
});

describe("header current file", () => {
  const toolCalls = { k1: { agentId: "S", phase: "running", startSeq: 1, filePaths: [FILE] } };

  it("truncates at the start so the file name stays visible", async () => {
    await render(
      <div style={{ width: 330 }}>
        <AgentPanel {...props("S")} store={makeStore({ toolCalls })} />
      </div>,
    );
    const file = part("agent-panel-file");
    expect(file.scrollWidth, "the path is longer than the line").toBeGreaterThan(
      file.clientWidth + 1,
    );
    // The last characters of the path lie inside the element's visible box.
    const node = Array.from(file.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) as Text;
    const range = document.createRange();
    range.setStart(node, Math.max(0, (node.textContent ?? "").length - 12));
    range.setEnd(node, (node.textContent ?? "").length);
    const tail = range.getBoundingClientRect();
    const box = file.getBoundingClientRect();
    expect(tail.right).toBeLessThanOrEqual(box.right + 1);
    expect(tail.left).toBeGreaterThanOrEqual(box.left - 1);
  });

  it("exposes the full path as a title or accessible name", async () => {
    await render(<AgentPanel {...props("S")} store={makeStore({ toolCalls })} />);
    const file = part("agent-panel-file");
    const full = file.getAttribute("title") ?? file.getAttribute("aria-label") ?? "";
    expect(full).toContain(FILE);
  });
});

function Harness() {
  const [id, setId] = useState("c");
  return <AgentPanel {...props(id, (next) => next !== null && setId(next))} store={makeStore()} />;
}

describe("keyboard focus", () => {
  it("stays inside the panel after the parent crumb is activated with Enter", async () => {
    await render(<Harness />);
    const lead = page.getByRole("button", { name: "Lead" }).element() as HTMLElement;
    lead.focus();
    expect(document.activeElement).toBe(lead);
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByTestId("agent-panel-name")).toHaveTextContent("Lead");
    expect(document.activeElement).not.toBe(document.body);
    expect(panel().contains(document.activeElement)).toBe(true);
  });

  it("does not clip the focus ring of a Files row in the tab slot", async () => {
    const frames = recorded.frames as never;
    await render(
      <AgentPanel
        {...props(A)}
        store={makeStore()}
        initialTab="files"
        renderTab={(tab, id) =>
          tab === "files" ? <FilesTab agentId={id} frames={frames} /> : null
        }
      />,
    );
    const row = page.getByTestId("file-row").element() as HTMLElement;
    // A key press first, so React Aria shows the keyboard focus ring.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    row.focus();
    await expect.poll(() => row.hasAttribute("data-focus-visible")).toBe(true);
    const style = getComputedStyle(row);
    expect(style.outlineStyle).not.toBe("none");
    const grow = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    const ring = row.getBoundingClientRect();
    const slot = part("agent-panel-tab-slot").getBoundingClientRect();
    expect(ring.left - grow).toBeGreaterThanOrEqual(slot.left - 0.5);
    expect(ring.right + grow).toBeLessThanOrEqual(slot.right + 0.5);
    expect(ring.top - grow).toBeGreaterThanOrEqual(slot.top - 0.5);
  });
});
