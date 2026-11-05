import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { movementLabels } from "../../city/movement/labels.ts";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayMode, OverlayProps } from "../host/types.ts";
import { AgentList } from "./AgentList.tsx";

// M7.17: with no agents in live mode the empty city tells a new user the two ways to get some.
// History keeps the plain "No agents yet", because a quiet moment in a recording is not a setup
// problem and "run taskville init" there would mislead.

const DEMO = "taskville demo";
const INIT = "taskville init";

const agent = {
  id: "a1",
  name: "Ada",
  status: "Testing",
  onTheWay: false,
  state: "working" as const,
  urgent: false,
};

function props(mode: OverlayMode = "live"): OverlayProps {
  return {
    mode,
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: null, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: mode === "live", run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

const guidance = () => page.getByRole("region", { name: /get agents|no agents yet/i });
const copyDemo = () => page.getByRole("button", { name: /copy.*taskville demo/i });
const copyInit = () => page.getByRole("button", { name: /copy.*taskville init/i });

afterEach(() => {
  movementLabels.set([]);
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("AgentList empty city guidance (live)", () => {
  it("shows both paths with their purpose", async () => {
    movementLabels.set([]);
    await render(<AgentList {...props()} />);
    const region = guidance();
    await expect.element(region).toBeVisible();
    await expect.element(region).toHaveTextContent(/see the city at work/i);
    await expect.element(region).toHaveTextContent(/watch your claude code sessions/i);
    await expect.element(region).toHaveTextContent(/repository/i);
  });

  it("puts each command in a code element", async () => {
    movementLabels.set([]);
    await render(<AgentList {...props()} />);
    for (const cmd of [DEMO, INIT]) {
      const el = page.getByText(cmd, { exact: true }).element();
      expect(el.tagName).toBe("CODE");
    }
  });

  it("links to the user guide", async () => {
    movementLabels.set([]);
    await render(<AgentList {...props()} />);
    const link = page.getByRole("link", { name: /user guide/i });
    await expect.element(link).toBeVisible();
    expect(link.element().getAttribute("href")).toBeTruthy();
  });

  it("copies the exact command with each copy button", async () => {
    const writeText = stubClipboard();
    movementLabels.set([]);
    await render(<AgentList {...props()} />);
    await copyDemo().click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith(DEMO);
    await copyInit().click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith(INIT);
  });

  it("is reachable and operable by keyboard", async () => {
    const writeText = stubClipboard();
    movementLabels.set([]);
    await render(<AgentList {...props()} />);
    await userEvent.tab();
    // Tab until the first copy button is focused (the list, if focusable, may come first).
    for (let i = 0; i < 6; i++) {
      if (document.activeElement === copyDemo().element()) break;
      await userEvent.tab();
    }
    await expect.element(copyDemo()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(DEMO));
    await userEvent.tab();
    await userEvent.tab();
    await expect.element(copyInit()).toHaveFocus();
  });

  it("gives the copy buttons and the guidance an accessible name", async () => {
    movementLabels.set([]);
    await render(<AgentList {...props()} />);
    await expect.element(guidance()).toBeInTheDocument();
    await expect.element(copyDemo()).toBeInTheDocument();
    await expect.element(copyInit()).toBeInTheDocument();
  });

  it("disappears as soon as an agent appears, and returns when they are gone", async () => {
    movementLabels.set([]);
    await render(<AgentList {...props()} />);
    await expect.element(guidance()).toBeInTheDocument();
    movementLabels.set([agent]);
    await expect.element(page.getByRole("row", { name: /Ada/ })).toBeVisible();
    expect(page.getByText(DEMO).query()).toBeNull();
    expect(page.getByText(INIT).query()).toBeNull();
    expect(page.getByRole("button", { name: /copy/i }).query()).toBeNull();
    expect(guidance().query()).toBeNull();
    movementLabels.set([]);
    await expect.element(guidance()).toBeInTheDocument();
  });

  it("renders only fixed text, never agent-supplied text", async () => {
    // Labels are the agent-supplied channel. An empty list has none, and a stale hostile label
    // must not leak into the guidance after the agents go away.
    movementLabels.set([{ ...agent, name: "<img src=x onerror=alert(1)>", status: "EVIL-STATUS" }]);
    await render(<AgentList {...props()} />);
    movementLabels.set([]);
    await expect.element(guidance()).toBeInTheDocument();
    const text = guidance().element().textContent ?? "";
    expect(text).not.toMatch(/EVIL-STATUS|onerror|<img/);
    expect(guidance().element().querySelector("img")).toBeNull();
  });
});

describe("AgentList empty city in history mode", () => {
  it("keeps the plain 'No agents yet' with no commands or copy buttons", async () => {
    movementLabels.set([]);
    await render(<AgentList {...props("history")} />);
    await expect.element(page.getByText("No agents yet", { exact: true })).toBeVisible();
    expect(page.getByText(DEMO).query()).toBeNull();
    expect(page.getByText(INIT).query()).toBeNull();
    expect(page.getByRole("button", { name: /copy/i }).query()).toBeNull();
    expect(page.getByRole("link", { name: /user guide/i }).query()).toBeNull();
  });
});
