import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { dataStore } from "../data/store.ts";
import { SessionProvider } from "../pairing/session.tsx";
import { OverlayRoot } from "./index.tsx";

// roborev 5612: ARCHITECTURE.md section 10 says the client keeps its last view on disconnect and
// marks it stale. The badge used to say "paired" whatever the connection was.

afterEach(() => {
  vi.unstubAllGlobals();
  dataStore.getState().reset("unsorted");
});

describe("OverlayRoot connection badge", () => {
  it("shows a stale indication while the connection is stale and clears it when live again", async () => {
    // Keep the sync loop parked on a request that never answers, so it cannot overwrite the
    // connection state this test sets.
    vi.stubGlobal(
      "fetch",
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await render(
      <SessionProvider value="test-session">
        <OverlayRoot />
      </SessionProvider>,
    );
    await expect.element(page.getByText(/stale/i)).not.toBeInTheDocument();

    dataStore.getState().setConnection("stale");
    const indicator = page.getByText(/stale/i);
    await expect.element(indicator).toBeVisible();
    // The badge states it in words (not colour alone), so it reads the same to a screen reader.
    await expect.element(indicator).toMatchTextContent(/stale/i);

    dataStore.getState().setConnection("live");
    await expect.element(page.getByText(/stale/i)).not.toBeInTheDocument();
  });
});
