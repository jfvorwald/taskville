import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Anchored, AnchorLayer } from "./AnchorLayer.tsx";
import { createAnchorSource } from "./anchors.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SIZE = { width: 600, height: 400 };

function rectOf(name: string) {
  return page.getByText(name).element().getBoundingClientRect();
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: "relative", width: SIZE.width, height: SIZE.height }}>{children}</div>
  );
}

function Label({ text }: { text: string }) {
  return (
    <span style={{ display: "block", width: 100, height: 20, background: "#ccc" }}>{text}</span>
  );
}

describe("AnchorLayer", () => {
  it("places a label centred above its projected anchor", async () => {
    const source = createAnchorSource();
    source.setAnchor("a", [0, 0, 0]); // ndc (0,0) is the centre of the layer
    source.setProjection(IDENTITY, SIZE);
    await render(
      <Frame>
        <AnchorLayer source={source}>
          <Anchored id="a" anchorId="a">
            <Label text="Alice" />
          </Anchored>
        </AnchorLayer>
      </Frame>,
    );
    await expect.element(page.getByText("Alice")).toBeVisible();
    const r = rectOf("Alice");
    const layer = page
      .getByText("Alice")
      .element()
      .closest("[data-anchor-layer]")
      ?.getBoundingClientRect();
    expect(layer).toBeDefined();
    expect(r.left + r.width / 2 - (layer?.left ?? 0)).toBeCloseTo(300, 0);
    expect(r.bottom - (layer?.top ?? 0)).toBeCloseTo(200, 0);
  });

  it("follows the anchor when the world or the camera changes", async () => {
    const source = createAnchorSource();
    source.setAnchor("a", [0, 0, 0]);
    source.setProjection(IDENTITY, SIZE);
    await render(
      <Frame>
        <AnchorLayer source={source}>
          <Anchored id="a" anchorId="a">
            <Label text="Alice" />
          </Anchored>
        </AnchorLayer>
      </Frame>,
    );
    await expect.element(page.getByText("Alice")).toBeVisible();
    const before = rectOf("Alice");
    source.setAnchor("a", [0.5, 0, 0]);
    await expect.poll(() => rectOf("Alice").left).toBeGreaterThan(before.left + 100);
  });

  it("keeps two labels on the same spot from overlapping, best priority in place", async () => {
    const source = createAnchorSource();
    source.setAnchor("a", [0, 0, 0]);
    source.setAnchor("b", [0, 0, 0]);
    source.setProjection(IDENTITY, SIZE);
    await render(
      <Frame>
        <AnchorLayer source={source} gap={4}>
          <Anchored id="a" anchorId="a" priority={1}>
            <Label text="Low" />
          </Anchored>
          <Anchored id="b" anchorId="b" priority={9}>
            <Label text="High" />
          </Anchored>
        </AnchorLayer>
      </Frame>,
    );
    await expect.element(page.getByText("Low")).toBeVisible();
    await expect.element(page.getByText("High")).toBeVisible();
    const high = rectOf("High");
    const low = rectOf("Low");
    expect(low.bottom).toBeLessThanOrEqual(high.top - 4 + 0.5);
  });

  it("hides a label whose anchor is off screen or unknown", async () => {
    const source = createAnchorSource();
    source.setAnchor("far", [5, 0, 0]);
    source.setProjection(IDENTITY, SIZE);
    await render(
      <Frame>
        <AnchorLayer source={source} margin={0}>
          <Anchored id="far" anchorId="far">
            <Label text="Offscreen" />
          </Anchored>
          <Anchored id="none" anchorId="nope">
            <Label text="Unknown" />
          </Anchored>
        </AnchorLayer>
      </Frame>,
    );
    await expect.element(page.getByText("Offscreen")).not.toBeVisible();
    await expect.element(page.getByText("Unknown")).not.toBeVisible();
  });

  it("does not catch pointer events outside interactive labels", async () => {
    const source = createAnchorSource();
    source.setAnchor("a", [0, 0, 0]);
    source.setProjection(IDENTITY, SIZE);
    await render(
      <Frame>
        <AnchorLayer source={source}>
          <Anchored id="a" anchorId="a">
            <Label text="Plain" />
          </Anchored>
        </AnchorLayer>
      </Frame>,
    );
    await expect.element(page.getByText("Plain")).toBeVisible();
    const label = page.getByText("Plain").element();
    const r = label.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 10, r.top + 5);
    // The point is over the label, but the label must not be what the pointer lands on.
    expect(hit).not.toBeNull();
    expect(label.contains(hit) || hit?.closest("[data-anchor-layer]") !== null).toBe(false);
  });
});
