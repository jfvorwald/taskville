import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PairingNotice } from "./PairingNotice.tsx";

describe("PairingNotice", () => {
  it("tells an unpaired browser how to pair, without offering data", async () => {
    await render(<PairingNotice state={{ status: "unpaired" }} onRetry={() => {}} />);
    await expect.element(page.getByRole("heading", { name: "Not paired" })).toBeVisible();
    await expect.element(page.getByText(/taskville serve/)).toBeVisible();
    expect(page.getByRole("button", { name: "Try again" }).elements()).toHaveLength(0);
  });

  it("explains a refused code", async () => {
    await render(
      <PairingNotice state={{ status: "failed", reason: "invalid_code" }} onRetry={() => {}} />,
    );
    await expect
      .element(page.getByRole("heading", { name: "Pairing link not accepted" }))
      .toBeVisible();
  });

  it("offers a keyboard-reachable retry when the engine cannot be reached", async () => {
    const onRetry = vi.fn();
    await render(
      <PairingNotice state={{ status: "failed", reason: "network" }} onRetry={onRetry} />,
    );
    await page.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not offer a retry that cannot work after the pairing code was spent", async () => {
    await render(
      <PairingNotice state={{ status: "failed", reason: "pairing_network" }} onRetry={() => {}} />,
    );
    await expect
      .element(page.getByRole("heading", { name: "Could not finish pairing" }))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Try again" }).elements()).toHaveLength(0);
  });
});
