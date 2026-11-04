import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { type Agent, initialState } from "../../../data/domain.ts";
import { dataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../../overlays/host/anchors.ts";
import type { OverlayProps } from "../../../overlays/host/types.ts";
import { selectionStore } from "../../interaction/selection.ts";
import { AgentLabels, agentAnchorId } from "../../movement/AgentLabels.tsx";
import { movementLabels } from "../../movement/labels.ts";
import { ConnectedFileScreen } from "./ConnectedFileScreen.tsx";

// M5.09 red round 3: the file screen is placed through the same collision layer as the name
// tags, so it never overlaps one. Both overlays are mounted the way the host mounts the
// world-labels slot, over one anchor source. Agent b1's tag sits exactly where a fixed lift above
// a1 would put the screen, so only real coordination keeps them apart. The observable: no
// intersection between the file screen and any agent-label rectangle.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SIZE = { width: 600, height: 400 };
const T = "2026-11-01T10:00:00.000Z";

const agent = (id: string) =>
  ({
    id,
    sourceId: "demo:7",
    sourceAgentId: id,
    displayName: id.toUpperCase(),
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: T,
    lastSeenAt: T,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
  }) as Agent;

const row = (id: string) => ({
  id,
  name: id.toUpperCase(),
  status: "working",
  onTheWay: false,
  state: "idle" as const,
  urgent: false,
});

afterEach(() => {
  selectionStore.select(null);
  dataStore.getState().reset(PROJECT);
  movementLabels.set([]);
});

function overlap(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("file screen placement", () => {
  it.each([
    [0, 30],
    [0, 60],
    [0, 90],
  ])("never overlaps a name tag (neighbour %ipx across, %ipx above)", async (dx, dy) => {
    const anchors = createAnchorSource();
    // ndc: x right, y up; the frame is 600x400, so one ndc unit is 300px across and 200px up.
    anchors.setAnchor(agentAnchorId("a1"), [0, 0, 0]);
    anchors.setAnchor(agentAnchorId("b1"), [dx / 300, dy / 200, 0]);
    anchors.setProjection(IDENTITY, SIZE);
    dataStore.getState().reset(PROJECT);
    dataStore.getState().applySnapshotState({
      ...initialState(PROJECT),
      agents: { a1: agent("a1"), b1: agent("b1") },
      toolCalls: {
        t1: { id: "t1", agentId: "a1", phase: "running", startSeq: 1, filePaths: ["/r/src/a.ts"] },
      },
    } as never);
    movementLabels.set([row("a1"), row("b1")]);
    selectionStore.select("a1");
    const props = { anchors } as unknown as OverlayProps;
    await render(
      <div style={{ position: "relative", width: SIZE.width, height: SIZE.height }}>
        <AgentLabels {...props} />
        <ConnectedFileScreen {...props} />
      </div>,
    );
    await expect.element(page.getByTestId("file-screen")).toHaveTextContent("a.ts");
    await expect.poll(() => page.getByTestId("agent-label").elements().length).toBe(2);
    const screen = page.getByTestId("file-screen").element().getBoundingClientRect();
    for (const tag of page.getByTestId("agent-label").elements()) {
      expect(overlap(screen, tag.getBoundingClientRect())).toBe(false);
    }
  });
});
