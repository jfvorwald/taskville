import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PairingNotice } from "./PairingNotice.tsx";

describe("PairingNotice", () => {
  it("tells an unpaired browser how to pair, without offering data", async () => {
    await render(<PairingNotice state={{ status: "unpaired" }} onRetry={() => {}} />);
    await expect.element(page.getByRole("heading", { name: "Not paired" })).toBeVisible();
    await expect.element(page.getByText(/taskville start/)).toBeVisible();
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

  // M7.19 (#400): copy names `taskville start`, and mentions pressing p only when the engine
  // listens for it. The flag arrives as `keyListener` on a failed state (from `&keys=1` in the link).
  it("unpaired: names taskville start and never mentions pressing p", async () => {
    await render(<PairingNotice state={{ status: "unpaired" }} onRetry={() => {}} />);
    await expect.element(page.getByText(/taskville start/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\bpress(ing)? p\b/i);
  });

  it("rejected without a key listener: names taskville start, no p", async () => {
    await render(
      <PairingNotice
        state={{ status: "failed", reason: "invalid_code", keyListener: false }}
        onRetry={() => {}}
      />,
    );
    await expect.element(page.getByText(/taskville start/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\bpress(ing)? p\b/i);
  });

  it("rejected with a key listener: names taskville start and says press p", async () => {
    await render(
      <PairingNotice
        state={{ status: "failed", reason: "invalid_code", keyListener: true }}
        onRetry={() => {}}
      />,
    );
    await expect.element(page.getByText(/taskville start/)).toBeVisible();
    expect(document.body.textContent).toMatch(/press p\b/i);
  });

  it("pairing_network follows the same rule", async () => {
    await render(
      <PairingNotice
        state={{ status: "failed", reason: "pairing_network", keyListener: false }}
        onRetry={() => {}}
      />,
    );
    expect(document.body.textContent).not.toMatch(/\bpress(ing)? p\b/i);
    expect(document.body.textContent).not.toMatch(/taskville serve/);
  });
});
