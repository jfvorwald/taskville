import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Attention } from "../../data/domain.ts";
import { dataStore } from "../../data/store.ts";
import { createAnchorSource } from "../host/anchors.ts";
import { resolveActiveOverlays } from "../host/registry.ts";
import type { AnchorSource, OverlayProps } from "../host/types.ts";
import { getSettingsStore } from "../settings/index.ts";
import { Bubbles, bubblesOverlay } from "./Bubbles.tsx";

// M4.06: the bubble overlay. At most three bubbles; the text is always a React text child (a
// phrase or an agent ID with markup never makes elements); the tool fact comes from the recorded
// request and only when it looks like a tool name; live mode only; reduced motion turns the fade
// off; and a second request for the same agent restarts the bubble (roborev 5859).

// A phrase that would be dangerous if it ever reached innerHTML.
const MARKUP_LINE = "<b>bold</b> <img src=x onerror=alert(1)> line";
vi.mock("../../quips/pick.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../quips/pick.ts")>()),
  pickQuip: () => MARKUP_LINE,
}));

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SIZE = { width: 900, height: 600 };

/** The agent anchor ids the city publishes: `agent:<id>`. */
function anchorsFor(ids: readonly string[]): AnchorSource {
  const source = createAnchorSource();
  ids.forEach((id, i) => {
    source.setAnchor(`agent:${id}`, [-0.8 + i * 0.3, 0, 0]);
  });
  source.setProjection(IDENTITY, SIZE);
  return source;
}

function props(anchors: AnchorSource, selectedId: string | null = null): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors,
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: "relative", width: SIZE.width, height: SIZE.height }}>{children}</div>
  );
}

/** A record whose first quip window opened `agoMs` ago, so it is open for the next few seconds. */
const since = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

const permission = (agentId: string, requestId: string, agoMs = 100): Attention => ({
  agentId,
  level: "needs_you",
  kind: "permission",
  since: since(agoMs),
  requestId,
  heuristic: false,
});

// Silent trouble is scheduled from its onset (last seen + threshold), so this uses a trouble kind
// whose quip clock is its own `since`.
const silent = (agentId: string, agoMs = 100): Attention => ({
  agentId,
  level: "trouble",
  kind: "tool_failures",
  since: since(agoMs),
  heuristic: false,
});

type Requests = Record<string, { toolName?: string }>;

function seed(attention: readonly Attention[], requests: Requests = {}) {
  dataStore.setState({
    attention,
    state: { requests } as unknown as NonNullable<ReturnType<typeof dataStore.getState>["state"]>,
  });
}

const bubbleEls = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="quip-bubble"]'));
const bubbleOf = (agentId: string) =>
  bubbleEls().find((el) => el.getAttribute("data-agent-id") === agentId);

beforeEach(() => {
  getSettingsStore().set("reducedMotion", "off");
});

afterEach(() => {
  dataStore.getState().reset("unsorted");
  getSettingsStore().set("reducedMotion", "system");
});

describe("Bubbles overlay cap", () => {
  it("renders at most three bubbles however many agents need attention", async () => {
    const ids = ["a1", "a2", "a3", "a4", "a5"];
    seed(ids.map((id, i) => permission(id, `req-${id}`, 100 + i * 10)));
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(ids))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(3);
    // Give the 500 ms tick a chance to add more; it must not.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(bubbleEls()).toHaveLength(3);
  });
});

// roborev 5873 #1: an agent whose anchor the layer would hide (projected outside the viewport and
// its margin, or no anchor published at all: `anchors.project(...)` is null or not `visible`) must
// not use up one of the three bubbles. The seam is the anchor source's own `project` visibility.
describe("Bubbles overlay cap and offscreen agents", () => {
  const at = (x: number) => [x, 0, 0] as const;
  const ON = at(0);
  const OFF = at(-5); // identity projection: x = -1800 px, far outside the margin

  function anchorsAt(positions: Record<string, readonly [number, number, number] | null>) {
    const source = createAnchorSource();
    for (const [id, position] of Object.entries(positions)) {
      if (position) source.setAnchor(`agent:${id}`, [position[0], position[1], position[2]]);
    }
    source.setProjection(IDENTITY, SIZE);
    return source;
  }

  const visibleBubble = (agentId: string) => {
    const el = bubbleOf(agentId);
    return el !== undefined && getComputedStyle(el).visibility === "visible";
  };

  it("shows the onscreen agent's bubble when the three older needs-you agents are offscreen", async () => {
    const ids = ["a1", "a2", "a3", "a4"];
    // a1 to a3 waited longest, so they outrank a4; none of them can be seen.
    seed(ids.map((id, i) => permission(id, `req-${id}`, 400 - i * 100)));
    const anchors = anchorsAt({ a1: OFF, a2: null, a3: OFF, a4: ON });
    await render(
      <Frame>
        <Bubbles {...props(anchors)} />
      </Frame>,
    );
    await expect.poll(() => visibleBubble("a4")).toBe(true);
    for (const id of ["a1", "a2", "a3"]) expect(visibleBubble(id)).toBe(false);
  });

  it("still caps at three among the agents that can be seen", async () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
    seed(ids.map((id, i) => permission(id, `req-${id}`, 500 - i * 50)));
    const anchors = anchorsAt({
      a1: OFF,
      a2: at(-0.8),
      a3: at(-0.4),
      a4: at(0),
      a5: at(0.4),
      a6: at(0.8),
    });
    await render(
      <Frame>
        <Bubbles {...props(anchors)} />
      </Frame>,
    );
    await expect.poll(() => ["a2", "a3", "a4"].every(visibleBubble)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(bubbleEls().filter((el) => getComputedStyle(el).visibility === "visible")).toHaveLength(
      3,
    );
    expect(visibleBubble("a1")).toBe(false);
  });

  it("shows an agent's bubble once its anchor comes onscreen", async () => {
    seed([permission("a1", "req-a1", 300)]);
    const anchors = anchorsAt({ a1: OFF });
    await render(
      <Frame>
        <Bubbles {...props(anchors)} />
      </Frame>,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(visibleBubble("a1")).toBe(false);
    anchors.setAnchor("agent:a1", [0, 0, 0]);
    await expect.poll(() => visibleBubble("a1")).toBe(true);
  });
});

describe("Bubbles overlay text", () => {
  it("renders a phrase with markup as text, never as elements", async () => {
    seed([permission("a1", "req-1")]);
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1"]))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(1);
    const el = bubbleEls()[0] as HTMLElement;
    expect(el.textContent).toContain("<b>bold</b>");
    expect(el.textContent).toContain("<img src=x");
    expect(el.querySelector("b, img, script")).toBeNull();
  });

  it("renders an agent ID with markup as nothing but an attribute", async () => {
    const evil = "<i>evil</i><u>x</u>";
    seed([permission(evil, "req-1")]);
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor([evil]))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(1);
    const el = bubbleEls()[0] as HTMLElement;
    expect(el.getAttribute("data-agent-id")).toBe(evil);
    expect(el.textContent).not.toContain("evil");
    expect(
      document.querySelector('[data-testid="quip-bubble"] i, [data-testid="quip-bubble"] u'),
    ).toBeNull();
    expect(document.querySelectorAll("i, u")).toHaveLength(0);
  });
});

describe("Bubbles overlay tool fact", () => {
  it("shows 'Needs OK: Bash' for a needs-you bubble whose request recorded Bash", async () => {
    seed([permission("a1", "req-1")], { "req-1": { toolName: "Bash" } });
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1"]))} />
      </Frame>,
    );
    await expect.element(page.getByText("Needs OK: Bash")).toBeInTheDocument();
  });

  it("takes the tool name from the record's own request, not from another request", async () => {
    seed([permission("a1", "req-1")], {
      "req-2": { toolName: "Bash" },
      "req-1": { toolName: "Read" },
    });
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1"]))} />
      </Frame>,
    );
    await expect.element(page.getByText("Needs OK: Read")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Needs OK: Bash");
  });

  it("shows no fact for a payload-looking tool name, a missing request, or a trouble bubble", async () => {
    const evilName = "rm -rf / <b>now</b>";
    seed([permission("a1", "req-1"), permission("a2", "req-missing"), silent("a3")], {
      "req-1": { toolName: evilName },
    });
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1", "a2", "a3"]))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(3);
    expect(document.body.textContent).not.toContain("Needs OK");
    expect(document.body.textContent).not.toContain("rm -rf");
    for (const el of bubbleEls()) expect(el.querySelector("b")).toBeNull();
  });
});

describe("Bubbles overlay mode", () => {
  it("is registered for live and history modes, so both resolve the same bubbles overlay", () => {
    expect(bubblesOverlay.slot).toBe("bubbles");
    expect(bubblesOverlay.modes).toEqual(["live", "history"]);
    const live = resolveActiveOverlays([bubblesOverlay], { mode: "live", enabled: ["bubbles"] });
    const history = resolveActiveOverlays([bubblesOverlay], {
      mode: "history",
      enabled: ["bubbles"],
    });
    expect(live.bubbles).toEqual([bubblesOverlay]);
    expect(history.bubbles).toEqual([bubblesOverlay]);
  });
});

describe("Bubbles overlay reduced motion", () => {
  it("fades the bubble in and out when motion is allowed", async () => {
    getSettingsStore().set("reducedMotion", "off");
    seed([permission("a1", "req-1")]);
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1"]))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(1);
    const el = bubbleEls()[0] as HTMLElement;
    expect(el.getAttribute("data-reduced-motion")).toBeNull();
    expect(getComputedStyle(el).animationName).not.toBe("none");
  });

  it("shows the bubble without the fade animation when reduced motion is on", async () => {
    getSettingsStore().set("reducedMotion", "on");
    seed([permission("a1", "req-1")]);
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1"]))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(1);
    const el = bubbleEls()[0] as HTMLElement;
    expect(el.getAttribute("data-reduced-motion")).toBe("true");
    expect(getComputedStyle(el).animationName).toBe("none");
  });
});

describe("Bubbles overlay restart (roborev 5859)", () => {
  it("restarts the bubble when a second request opens for the same agent inside the first window", async () => {
    seed([permission("a1", "req-1", 500)]);
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1"]))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(1);
    const first = bubbleOf("a1") as HTMLElement;

    // The first request is answered and a new one opens, still inside the first 4 s window.
    seed([permission("a1", "req-2", 50)], { "req-2": { toolName: "Bash" } });

    // A new request is a new bubble: a fresh element, so the fade starts again.
    await expect.poll(() => first.isConnected).toBe(false);
    await expect.poll(() => bubbleEls().length).toBe(1);
    const second = bubbleOf("a1") as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.textContent).toContain("Needs OK: Bash");
  });

  it("keeps the same element while the same request stays open", async () => {
    seed([permission("a1", "req-1", 500)]);
    await render(
      <Frame>
        <Bubbles {...props(anchorsFor(["a1"]))} />
      </Frame>,
    );
    await expect.poll(() => bubbleEls().length).toBe(1);
    const first = bubbleOf("a1") as HTMLElement;
    // Same record again (new array, same request): no restart.
    seed([permission("a1", "req-1", 500)]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(first.isConnected).toBe(true);
    expect(bubbleOf("a1")).toBe(first);
  });
});
