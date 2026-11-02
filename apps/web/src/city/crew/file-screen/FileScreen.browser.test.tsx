import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Anchored, AnchorLayer } from "../../../overlays/host/AnchorLayer.tsx";
import { createAnchorSource } from "../../../overlays/host/anchors.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { FileScreen } from "./FileScreen.tsx";

// M5.09 red: the floating current-file screen above the selected agent's workstation.
// Interface: <FileScreen agentId={string | null} path={string | null | undefined} /> renders, inside
// an AnchorLayer, one small element [data-testid="file-screen"] anchored to agentAnchorId(agentId)
// whose text is fileScreenLabel(path). No agentId (nothing selected), or no projected anchor, means
// nothing is rendered. The caller passes the selected agent's id and current file.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SIZE = { width: 600, height: 400 };

function Harness({
  source,
  agentId,
  path,
}: {
  source: ReturnType<typeof createAnchorSource>;
  agentId: string | null;
  path: string | null;
}) {
  return (
    <div style={{ position: "relative", width: SIZE.width, height: SIZE.height }}>
      <AnchorLayer source={source}>
        <Anchored id="marker" anchorId={agentAnchorId("a1")}>
          <span style={{ display: "block", width: 20, height: 20 }}>bot</span>
        </Anchored>
        <FileScreen agentId={agentId} path={path} />
      </AnchorLayer>
    </div>
  );
}

function ready() {
  const source = createAnchorSource();
  source.setAnchor(agentAnchorId("a1"), [0, 0, 0]);
  source.setProjection(IDENTITY, SIZE);
  return source;
}

describe("FileScreen", () => {
  it("shows the current file name above the selected agent", async () => {
    await render(<Harness source={ready()} agentId="a1" path="/Users/me/app/src/city/path.ts" />);
    const screen = page.getByTestId("file-screen");
    await expect.element(screen).toBeVisible();
    await expect.element(screen).toHaveTextContent("path.ts");
    expect(screen.element().textContent).not.toContain("/Users");
    const above = screen.element().getBoundingClientRect().bottom;
    expect(above).toBeLessThanOrEqual(
      page.getByText("bot").element().getBoundingClientRect().top + 1,
    );
  });

  it("follows the file as it changes, and shows the placeholder with no file", async () => {
    const source = ready();
    const view = await render(<Harness source={source} agentId="a1" path="/a/one.ts" />);
    await expect.element(page.getByTestId("file-screen")).toHaveTextContent("one.ts");
    await view.rerender(<Harness source={source} agentId="a1" path="/a/two.ts" />);
    await expect.element(page.getByTestId("file-screen")).toHaveTextContent("two.ts");
    await view.rerender(<Harness source={source} agentId="a1" path={null} />);
    await expect.element(page.getByTestId("file-screen")).toHaveTextContent("no file");
  });

  it("renders nothing when no agent is selected", async () => {
    await render(<Harness source={ready()} agentId={null} path="/a/one.ts" />);
    await expect.element(page.getByText("bot")).toBeVisible();
    expect(page.getByTestId("file-screen").elements()).toHaveLength(0);
  });

  it("shows markup in a file name as literal text", async () => {
    await render(
      <Harness source={ready()} agentId="a1" path="/a/<img src=x onerror=alert(1)>.ts" />,
    );
    const el = page.getByTestId("file-screen").element();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img");
  });
});
