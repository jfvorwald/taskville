import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "./anchors.ts";
import { InteractiveRegion } from "./InteractiveRegion.tsx";
import { OverlayHost, type OverlayHostProps } from "./OverlayHost.tsx";
import { createOverlayRegistry } from "./registry.ts";
import type { OverlayDefinition, OverlayProps } from "./types.ts";

function overlay(
  id: string,
  slot: OverlayDefinition["slot"],
  modes: OverlayDefinition["modes"] = ["live", "history"],
  text = id,
): OverlayDefinition {
  // biome-ignore lint/correctness/noComponentHookFactories: test fixture, built once per test
  return { id, slot, modes, Component: () => <p>{text}</p> };
}

function host(over: Partial<OverlayHostProps> = {}): OverlayHostProps {
  return {
    registry: createOverlayRegistry(),
    mode: "live",
    enabled: [],
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: null, select: () => {} },
    anchors: createAnchorSource(),
    runIntent: () => {},
    storage: null,
    ...over,
  };
}

describe("OverlayHost: registry and modes", () => {
  it("renders enabled overlays and only those", async () => {
    const registry = createOverlayRegistry([
      overlay("alpha", "header"),
      overlay("beta", "timeline"),
    ]);
    await render(<OverlayHost {...host({ registry, enabled: ["alpha"] })} />);
    await expect.element(page.getByText("alpha")).toBeVisible();
    expect(page.getByText("beta").elements()).toHaveLength(0);
  });

  it("swaps overlays when the mode changes", async () => {
    const registry = createOverlayRegistry([
      overlay("live-only", "bubbles", ["live"]),
      overlay("history-only", "timeline", ["history"]),
    ]);
    const enabled = ["live-only", "history-only"];
    const screen = await render(<OverlayHost {...host({ registry, enabled, mode: "live" })} />);
    await expect.element(page.getByText("live-only")).toBeVisible();
    expect(page.getByText("history-only").elements()).toHaveLength(0);
    await screen.rerender(<OverlayHost {...host({ registry, enabled, mode: "history" })} />);
    await expect.element(page.getByText("history-only")).toBeVisible();
    expect(page.getByText("live-only").elements()).toHaveLength(0);
  });

  it("shows overlays registered after mount", async () => {
    const registry = createOverlayRegistry();
    await render(<OverlayHost {...host({ registry, enabled: ["late"] })} />);
    expect(page.getByText("late").elements()).toHaveLength(0);
    registry.register(overlay("late", "header"));
    await expect.element(page.getByText("late")).toBeVisible();
  });

  it("passes each overlay its props, with the mode", async () => {
    const seen: OverlayProps[] = [];
    const registry = createOverlayRegistry([
      {
        id: "probe",
        slot: "header",
        modes: ["live", "history"],
        // biome-ignore lint/correctness/noComponentHookFactories: test fixture, built once per test
        Component: (props) => {
          seen.push(props);
          return <p>probe</p>;
        },
      },
    ]);
    await render(<OverlayHost {...host({ registry, enabled: ["probe"], mode: "history" })} />);
    await expect.element(page.getByText("probe")).toBeVisible();
    expect(seen[0]?.mode).toBe("history");
    expect(seen[0]?.intents.available).toBe(false);
  });
});

describe("OverlayHost: single sidebar", () => {
  const registry = createOverlayRegistry([
    overlay("panel", "sidebar"),
    overlay("queue", "sidebar"),
  ]);

  it("mounts one sidebar even when two are enabled", async () => {
    await render(<OverlayHost {...host({ registry, enabled: ["panel", "queue"] })} />);
    await expect.element(page.getByText("panel")).toBeVisible();
    expect(page.getByText("queue").elements()).toHaveLength(0);
  });

  it("switches to the chosen sidebar", async () => {
    const screen = await render(
      <OverlayHost {...host({ registry, enabled: ["panel", "queue"] })} />,
    );
    await screen.rerender(
      <OverlayHost {...host({ registry, enabled: ["panel", "queue"], sidebar: "queue" })} />,
    );
    await expect.element(page.getByText("queue")).toBeVisible();
    expect(page.getByText("panel").elements()).toHaveLength(0);
  });
});

describe("OverlayHost: a broken overlay", () => {
  it("is contained, and its neighbours keep rendering", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = createOverlayRegistry([
      {
        id: "bad",
        slot: "header",
        modes: ["live"],
        // biome-ignore lint/correctness/noComponentHookFactories: test fixture, built once per test
        Component: () => {
          throw new Error("boom");
        },
      },
      overlay("good", "timeline", ["live"]),
    ]);
    await render(<OverlayHost {...host({ registry, enabled: ["bad", "good"] })} />);
    await expect.element(page.getByText("good")).toBeVisible();
    spy.mockRestore();
  });
});

describe("OverlayHost: pointer routing", () => {
  it("lets clicks through transparent areas to what is underneath, and keeps them on interactive regions", async () => {
    const onScene = vi.fn();
    const onOverlay = vi.fn();
    const registry = createOverlayRegistry([
      {
        id: "card",
        slot: "sidebar",
        modes: ["live"],
        // biome-ignore lint/correctness/noComponentHookFactories: test fixture, built once per test
        Component: () => (
          <InteractiveRegion>
            <button type="button" onClick={onOverlay}>
              Overlay button
            </button>
          </InteractiveRegion>
        ),
      },
    ]);
    await render(
      <div style={{ position: "relative", width: 600, height: 400 }}>
        <button
          type="button"
          onClick={onScene}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        >
          Scene
        </button>
        <OverlayHost {...host({ registry, enabled: ["card"] })} />
      </div>,
    );
    // Playwright refuses to click an element another element covers, so these clicks
    // only succeed if the host's empty space really lets the pointer through.
    await page.getByRole("button", { name: "Overlay button" }).click();
    expect(onOverlay).toHaveBeenCalledOnce();
    expect(onScene).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Scene" }).click({ position: { x: 20, y: 200 } });
    expect(onScene).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
  });
});
