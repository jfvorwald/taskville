import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../../overlays/host/anchors.ts";
import type { OverlayProps } from "../../overlays/host/types.ts";
import { CameraControls } from "./CameraControls.tsx";
import { cameraRig } from "./cameraRig.ts";

// M5.08 red round 3 (S3): "Reset view" is enabled whenever the view is not the default, including
// when the only change is a pan (a Crew pick). It is disabled at the default view.
const props: OverlayProps = {
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: null, select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
};

afterEach(() => cameraRig.reset());

describe("CameraControls reset", () => {
  it("is disabled at the default view", async () => {
    render(<CameraControls {...props} />);
    await expect.element(page.getByRole("button", { name: "Reset view" })).toBeDisabled();
  });

  it("is enabled when only panned, and clears the pan", async () => {
    render(<CameraControls {...props} />);
    cameraRig.panBy(2, 0);
    const reset = page.getByRole("button", { name: "Reset view" });
    await expect.element(reset).toBeEnabled();
    await reset.click();
    expect(cameraRig.getSnapshot().panX).toBe(0);
    await expect.element(reset).toBeDisabled();
  });
});
