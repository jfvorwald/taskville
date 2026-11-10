import { Profiler, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { Anchored, AnchorLayer } from "./AnchorLayer.tsx";
import { createAnchorSource } from "./anchors.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SIZE = { width: 600, height: 400 };
const AGENTS = 6;
const FRAMES = 30;
const IDS = Array.from({ length: AGENTS }, (_, i) => i);

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

function Label({ text }: { text: string }) {
  return <span style={{ display: "block", width: 60, height: 20 }}>{text}</span>;
}

function Layer({
  name,
  source,
  commits,
  children,
}: {
  name: string;
  source: ReturnType<typeof createAnchorSource>;
  commits: Map<string, number>;
  children?: ReactNode;
}) {
  return (
    <Profiler
      id={name}
      onRender={(id, phase) => {
        // A mount is not a commit caused by movement; only count updates.
        if (phase === "update" || phase === "nested-update") {
          commits.set(id, (commits.get(id) ?? 0) + 1);
        }
      }}
    >
      <AnchorLayer source={source}>
        {IDS.map((i) => (
          <Anchored key={`${name}-${i}`} id={`${name}-${i}`} anchorId={`agent:${i}`}>
            <Label text={`${name} ${i}`} />
          </Anchored>
        ))}
        {children}
      </AnchorLayer>
    </Profiler>
  );
}

describe("AnchorLayer commits while agents walk", () => {
  it("commits at most 2 per animation frame across two layers, with no store events", async () => {
    const source = createAnchorSource();
    for (let i = 0; i < AGENTS; i++) source.setAnchor(`agent:${i}`, [i / 10 - 0.3, 0, 0]);
    source.setProjection(IDENTITY, SIZE);
    const commits = new Map<string, number>();
    await render(
      <div style={{ position: "relative", width: SIZE.width, height: SIZE.height }}>
        <Layer name="labels" source={source} commits={commits} />
        <Layer name="bubbles" source={source} commits={commits} />
      </div>,
    );
    // Let mount-time registration and measurement settle before counting.
    await nextFrame();
    await nextFrame();
    await nextFrame();
    commits.clear();

    // Each frame every agent steps a little, the way the city publishes positions: one
    // setAnchor per agent, no store event.
    for (let frame = 0; frame < FRAMES; frame++) {
      await nextFrame();
      for (let i = 0; i < AGENTS; i++) {
        source.setAnchor(`agent:${i}`, [i / 10 - 0.3 + frame / 200, (i % 3) / 10, 0]);
      }
    }
    await nextFrame();

    const total = [...commits.values()].reduce((a, b) => a + b, 0);
    const perFrame = total / FRAMES;
    const detail = `${total} commits in ${FRAMES} frames (${[...commits].map(([k, v]) => `${k}=${v}`).join(", ")})`;
    expect(perFrame, detail).toBeLessThanOrEqual(2);
    expect(total, detail).toBeGreaterThan(0);
  });
});
