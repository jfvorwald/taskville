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

  // M7.19 (#400), roborev 7127 (medium): recovery copy. With a key listener the page says to
  // press p in the terminal running taskville. Otherwise it says to stop taskville (Ctrl+C) and
  // run `taskville start` again. It never implies that a plain `taskville start` issues a new
  // link while an engine is running. `keyListener` arrives on a failed state (`&keys=1`).
  const PRESS_P = /press p in the terminal running taskville/i;
  const STOP_AND_RERUN = /stop taskville \(Ctrl\+C\)[\s\S]*run taskville start again/i;
  const SOME_P = /\bpress(ing)? p\b/i;
  const text = () => document.body.textContent ?? "";

  type Failed = Extract<Parameters<typeof PairingNotice>[0]["state"], { status: "failed" }>;
  const reasons: Failed["reason"][] = ["invalid_code", "pairing_network", "network"];

  for (const reason of reasons) {
    it(`${reason} with a key listener: says press p in the terminal running taskville`, async () => {
      await render(
        <PairingNotice
          state={{ status: "failed", reason, keyListener: true }}
          onRetry={() => {}}
        />,
      );
      expect(text()).toMatch(PRESS_P);
    });

    it(`${reason} without a key listener: says stop taskville (Ctrl+C) and run taskville start again`, async () => {
      await render(
        <PairingNotice
          state={{ status: "failed", reason, keyListener: false }}
          onRetry={() => {}}
        />,
      );
      expect(text()).toMatch(STOP_AND_RERUN);
      expect(text()).not.toMatch(SOME_P);
      expect(text()).not.toMatch(/taskville serve/);
    });
  }

  it("a network failure with no flag at all gives the stop-and-rerun recovery", async () => {
    await render(
      <PairingNotice state={{ status: "failed", reason: "network" }} onRetry={() => {}} />,
    );
    expect(text()).toMatch(STOP_AND_RERUN);
    expect(text()).not.toMatch(SOME_P);
  });

  it("unpaired: stop-and-rerun recovery, never press p", async () => {
    await render(<PairingNotice state={{ status: "unpaired" }} onRetry={() => {}} />);
    expect(text()).toMatch(STOP_AND_RERUN);
    expect(text()).not.toMatch(SOME_P);
  });

  it("the p-key screens do not tell the user to run a bare taskville start for a new link", async () => {
    await render(
      <PairingNotice
        state={{ status: "failed", reason: "invalid_code", keyListener: true }}
        onRetry={() => {}}
      />,
    );
    expect(text()).not.toMatch(/run taskville start for a new/i);
  });
});
