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

// An explicit line height keeps the clamp arithmetic independent of the machine's fonts.
const frame = { width: 400, lineHeight: "20px", fontFamily: "sans-serif" } as const;
const crew = (result: string, more: Record<string, unknown> = {}, idle = false) => (
  <div style={frame}>
    <CrewTab
      parentId="L"
      agents={{ ...(agents as object), ...more } as never}
      activity={
        (idle ? { ...(activity as object), idle: { activity: "idle" } } : activity) as never
      }
      results={{ done: result }}
      nowMs={NOW}
      onSelect={() => {}}
      onHover={() => {}}
    />
  </div>
);
async function mount(result: string) {
  return render(crew(result));
}

const rowOf = (id: string) =>
  page
    .getByTestId("crew-row")
    .elements()
    .find((e) => e.getAttribute("data-agent-id") === id) as HTMLElement | undefined;
const node = (id: string) => {
  const found = rowOf(id)?.querySelector('[data-testid="crew-row-dot"]');
  if (!found) throw new Error(`no status node for ${id}`);
  return found as HTMLElement;
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
  it("paints a running node hollow in --tv-running and a completed node filled in --tv-ok", async () => {
    await mount("Done.");
    const running = getComputedStyle(node("run"));
    const done = getComputedStyle(node("done"));
    expect(running.borderTopColor).toBe(tokenColor("--tv-running"));
    expect(running.borderTopWidth).not.toBe("0px");
    expect(done.backgroundColor).toBe(tokenColor("--tv-ok"));
    expect(done.backgroundColor).not.toBe(running.backgroundColor);
  });

  it("has a text equivalent for every state", async () => {
    await render(
      crew(
        "Done.",
        { quiet: mk("quiet", { kind: "subagent", parentAgentId: "L", registeredSeq: 9 }) },
        true,
      ),
    );
    const textOf = (id: string) => {
      const n = node(id);
      const label = n.getAttribute("aria-label");
      if (label !== null) expect(n.getAttribute("role")).toBe("img");
      return (label ?? n.textContent ?? "").trim();
    };
    expect(textOf("run")).toBe("Working");
    expect(textOf("done")).toBe("Finished");
    expect(textOf("quiet")).toBe("Unknown");
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

  it("shows a Show more control when the text grows from two to five lines", async () => {
    const view = await render(crew("First line.\nSecond line."));
    expect(toggle()).toBeNull();
    await view.rerender(crew("One.\nTwo.\nThree.\nFour.\nFive."));
    await expect.poll(() => toggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses runs of blank lines in the clamped view", async () => {
    await mount("Done.\n\n\nDetails here");
    const el = summary();
    expect(el.textContent).toContain("Done.");
    expect(el.textContent).toContain("Details here");
    // Both lines fit in the two clamped lines: nothing is hidden, so no toggle is needed.
    expect(el.scrollHeight).toBeLessThanOrEqual(el.clientHeight + 1);
    expect(toggle()).toBeNull();
  });

  it("names the child in the toggle's accessible name", async () => {
    await mount(LONG);
    await expect
      .element(page.getByRole("button", { name: "Show more of Reviewer's result" }))
      .toBeVisible();
    toggle()?.click();
    await expect
      .element(page.getByRole("button", { name: "Show less of Reviewer's result" }))
      .toBeVisible();
  });
});
