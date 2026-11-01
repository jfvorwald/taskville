import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SessionProvider } from "../pairing/session.tsx";
import { OverlayRoot } from "./index.tsx";

describe("OverlayRoot", () => {
  it("mounts the host with the counts header and keeps the paired badge", async () => {
    // OverlayRoot starts the data sync (M3.06), which needs a paired session.
    await render(
      <SessionProvider value="test-session">
        <OverlayRoot />
      </SessionProvider>,
    );
    const status = page.getByRole("status");
    await expect.element(status).toBeVisible();
    await expect.element(status).toHaveTextContent("0 active · 0 need you");
    await expect.element(page.getByText("Taskville · paired")).toBeVisible();
    expect(page.getByTestId("overlay-root").elements()).toHaveLength(1);
  });
});
