import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Anchored, AnchorLayer } from "./AnchorLayer.tsx";
import { createAnchorSource } from "./anchors.ts";

// roborev 5600: `.anchored` and `.interactive` have equal specificity and `.anchored` comes later
// in host.module.css, so an interactive label ended up pointer-events: none.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SIZE = { width: 600, height: 400 };

const pointerEventsOf = (element: Element) => getComputedStyle(element).pointerEvents;

describe("Anchored pointer routing", () => {
  it("lets the pointer reach an interactive anchored label and not a plain one", async () => {
    const source = createAnchorSource();
    source.setAnchor("a", [0, 0, 0]);
    source.setAnchor("b", [0.5, 0.5, 0]);
    source.setProjection(IDENTITY, SIZE);
    await render(
      <div style={{ position: "relative", width: SIZE.width, height: SIZE.height }}>
        <AnchorLayer source={source}>
          <Anchored id="clickable" anchorId="a" interactive>
            <button type="button">Open Alice</button>
          </Anchored>
          <Anchored id="plain" anchorId="b">
            <span>Bob</span>
          </Anchored>
        </AnchorLayer>
      </div>,
    );
    await expect.element(page.getByText("Open Alice")).toBeVisible();

    const button = page.getByRole("button", { name: "Open Alice" }).element();
    // The wrapper is the element carrying the host classes; the button inherits its value.
    expect(pointerEventsOf(button.parentElement as Element)).toBe("auto");
    expect(pointerEventsOf(button)).toBe("auto");
    expect(pointerEventsOf(page.getByText("Bob").element().parentElement as Element)).toBe("none");
  });
});
