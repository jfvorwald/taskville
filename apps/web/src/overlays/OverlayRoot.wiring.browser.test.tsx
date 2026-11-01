import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { selectionStore } from "../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../data/project.ts";
import { dataStore } from "../data/store.ts";
import { SessionProvider } from "../pairing/session.tsx";
import { OverlayRoot } from "./index.tsx";

// M4.01 code review: the pieces were tested alone, but nothing mounted OverlayRoot and checked
// that it connects them. A request that never answers keeps the sync loops parked, so what the
// test sees is only which requests the app opens.

let urls: string[] = [];

beforeEach(() => {
  urls = [];
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
});

const mount = () =>
  render(
    <SessionProvider value="test-session">
      <OverlayRoot />
    </SessionProvider>,
  );

describe("OverlayRoot wiring", () => {
  it("opens the global attention feed", async () => {
    await mount();
    await vi.waitFor(() => expect(urls).toContain("/v1/attention/events"));
  });

  it("syncs the project the viewer picks: choosing another project requests its snapshot", async () => {
    await mount();
    await vi.waitFor(() => expect(urls).toContain("/v1/projects/unsorted/snapshot"));
    expect(urls.some((u) => u.includes("/v1/projects/beta/"))).toBe(false);

    selectProject("beta");
    await vi.waitFor(() => expect(urls).toContain("/v1/projects/beta/snapshot"));
  });

  it("does not reopen the attention feed when the project changes", async () => {
    await mount();
    await vi.waitFor(() => expect(urls).toContain("/v1/attention/events"));
    selectProject("beta");
    await vi.waitFor(() => expect(urls).toContain("/v1/projects/beta/snapshot"));
    expect(urls.filter((u) => u === "/v1/attention/events")).toHaveLength(1);
  });

  it("clears the city selection when the project changes, since the selected agent is not in the new one (S2)", async () => {
    await mount();
    await vi.waitFor(() => expect(urls).toContain("/v1/projects/unsorted/snapshot"));
    selectionStore.select("agent-1");
    expect(selectionStore.getSnapshot()).toBe("agent-1");

    selectProject("beta");
    await vi.waitFor(() => expect(selectionStore.getSnapshot()).toBeNull());
  });

  it("keeps the selection when the same project is chosen again", async () => {
    await mount();
    await vi.waitFor(() => expect(urls).toContain("/v1/projects/unsorted/snapshot"));
    selectionStore.select("agent-1");
    selectProject(DEFAULT_PROJECT_ID);
    await new Promise((r) => setTimeout(r, 50));
    expect(selectionStore.getSnapshot()).toBe("agent-1");
  });
});
