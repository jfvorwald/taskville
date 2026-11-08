import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../../../styles/tokens.css";
import { CrewTab } from "./CrewTab.tsx";

// M10.03 red: Crew rows in the thread style (design 2026-11-08-agent-panel-readability).
// Each row has a status node whose color reflects state (tokens), a finished child's result is
// clamped to two lines until activated (mouse or keyboard), and result text is plain text.
// The expand control is any element inside the row carrying aria-expanded.
// Not pinned: a "failed" node. The Agent record carries no failure outcome today, so only
// running vs completed are distinguished here; --tv-fail itself is pinned in the shell tests.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const mk = (id: string, over: Record<string, unknown>) => ({
  id,
  sourceId: "claude-code",
  registered: true,
  connection: "connected",
  firstSeenAt: iso(-60_000),
  lastSeenAt: iso(0),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
  ...over,
});
const LONG = Array.from(
  { length: 14 },
  (_, i) => `Sentence number ${i} explains what the reviewer found.`,
).join(" ");
const agents = {
  L: mk("L", { kind: "lead", displayName: "Lead", registeredSeq: 1 }),
  run: mk("run", { kind: "subagent", parentAgentId: "L", displayName: "Runner", registeredSeq: 2 }),
  done: mk("done", {
    kind: "subagent",
    parentAgentId: "L",
    displayName: "Reviewer",
    registeredSeq: 3,
    finishedAt: iso(-1000),
  }),
} as never;
const activity = { run: { activity: "testing" } } as never;

async function mount(result: string) {
  return render(
    <div style={{ width: 400 }}>
      <CrewTab
        parentId="L"
        agents={agents}
        activity={activity}
        results={{ done: result }}
        nowMs={NOW}
        onSelect={() => {}}
        onHover={() => {}}
      />
    </div>,
  );
}

const rowOf = (id: string) =>
  page
    .getByTestId("crew-row")
    .elements()
    .find((e) => e.getAttribute("data-agent-id") === id) as HTMLElement | undefined;
const nodeColor = (id: string) => {
  const node = rowOf(id)?.querySelector('[data-testid="crew-row-dot"]');
  if (!node) throw new Error(`no status node for ${id}`);
  return getComputedStyle(node).color;
};
/** A token's resolved color, read through a probe element. */
const tokenColor = (token: string) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
};
const lineHeight = (el: Element) => {
  const lh = getComputedStyle(el).lineHeight;
  return lh === "normal"
    ? Number.parseFloat(getComputedStyle(el).fontSize) * 1.2
    : Number.parseFloat(lh);
};

describe("Crew status nodes", () => {
  it("colors a running node with --tv-running and a completed node with --tv-ok", async () => {
    await mount("Done.");
    expect(nodeColor("run")).toBe(tokenColor("--tv-running"));
    expect(nodeColor("done")).toBe(tokenColor("--tv-ok"));
    expect(nodeColor("run")).not.toBe(nodeColor("done"));
  });
});

describe("Crew result", () => {
  const summary = () =>
    rowOf("done")?.querySelector('[data-testid="crew-row-summary"]') as HTMLElement;
  const toggle = () => rowOf("done")?.querySelector("[aria-expanded]") as HTMLElement | null;

  it("shows at most two lines collapsed", async () => {
    await mount(LONG);
    const el = summary();
    expect(el.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight(el) * 2 + 2);
    expect(el.scrollHeight).toBeGreaterThan(lineHeight(el) * 2 + 2);
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands on click", async () => {
    await mount(LONG);
    toggle()?.click();
    await expect.poll(() => toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(summary().getBoundingClientRect().height).toBeGreaterThan(lineHeight(summary()) * 3);
  });

  it("expands from the keyboard", async () => {
    await mount(LONG);
    toggle()?.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(summary().getBoundingClientRect().height).toBeGreaterThan(lineHeight(summary()) * 3);
    await userEvent.keyboard(" ");
    await expect.poll(() => toggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders result text as plain text, never Markdown", async () => {
    await mount("Found **bold** and `code` and <b>tags</b>");
    const el = summary();
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toContain("**bold**");
    expect(el.textContent).toContain("`code`");
    expect(el.textContent).toContain("<b>tags</b>");
  });
});
