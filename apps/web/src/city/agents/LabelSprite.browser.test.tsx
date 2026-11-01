import { Canvas } from "@react-three/fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { themeController } from "../../themes/core/index.ts";
import { LabelSprite } from "./LabelSprite.tsx";

// The app registers one theme today. A second one, with its own text colours, lets the test
// switch themes. The labels read their colours from the document root's `--tv-*` properties.
vi.mock("../../themes/core/themes.ts", async () => {
  const { createThemeController } = await import("../../themes/core/controller.ts");
  const { cyberpunkTheme } = await import("../../themes/cyberpunk/index.ts");
  const steampunkTheme = {
    ...cyberpunkTheme,
    id: "steampunk" as const,
    name: "Steampunk",
    tokens: { ...cyberpunkTheme.tokens, "--tv-text": "#f1e2c4", "--tv-text-muted": "#b59f78" },
  };
  const THEMES = [cyberpunkTheme, steampunkTheme];
  return { THEMES, themeController: createThemeController({ themes: THEMES }) };
});

/** The fill colours the label canvas is drawn with, in call order. */
function spyOnLabelFills() {
  const fills: string[] = [];
  const original = CanvasRenderingContext2D.prototype.fillText;
  const spy = vi.spyOn(CanvasRenderingContext2D.prototype, "fillText").mockImplementation(function (
    this: CanvasRenderingContext2D,
    ...args
  ) {
    fills.push(String(this.fillStyle));
    return original.apply(this, args);
  });
  return { fills, spy };
}

describe("LabelSprite", () => {
  let detach: (() => void) | undefined;
  afterEach(() => {
    detach?.();
    themeController.setTheme("cyberpunk");
    vi.restoreAllMocks();
  });

  it("redraws with the new theme's text colours after a theme switch", async () => {
    detach = themeController.attach(document.documentElement);
    const { fills } = spyOnLabelFills();
    await render(
      <div style={{ width: 200, height: 120 }}>
        <Canvas>
          <LabelSprite label={{ name: "Ada", status: "Idle" }} y={1} inverseScale={1} />
        </Canvas>
      </div>,
    );
    await vi.waitFor(() => expect(fills).toEqual(expect.arrayContaining(["#d8e6ff", "#8a9bc4"])));

    fills.length = 0;
    themeController.setTheme("steampunk");
    await vi.waitFor(() => expect(fills).toEqual(expect.arrayContaining(["#f1e2c4", "#b59f78"])));
    expect(fills).not.toContain("#d8e6ff");
  });
});
