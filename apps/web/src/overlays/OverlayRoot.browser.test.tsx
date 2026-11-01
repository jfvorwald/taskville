import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { OverlayRoot } from "./index.tsx";

describe("OverlayRoot", () => {
  it("mounts the host with the counts header and keeps the paired badge", async () => {
    await render(<OverlayRoot />);
    const status = page.getByRole("status");
    await expect.element(status).toBeVisible();
    await expect.element(status).toHaveTextContent("0 active · 0 need you");
    await expect.element(page.getByText("Taskville · paired")).toBeVisible();
    expect(page.getByTestId("overlay-root").elements()).toHaveLength(1);
  });
});
