import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { needsYou, trouble } from "../../test/audio/fakes.ts";
import { getSoundscape } from "../audio/index.ts";
import { selectionStore } from "../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../data/project.ts";
import { dataStore } from "../data/store.ts";
import { SessionProvider } from "../pairing/session.tsx";
import { OverlayRoot } from "./index.tsx";

// M4.09 wiring: the soundscape core is unit tested with fakes, but nothing mounted OverlayRoot and
// checked that it creates the soundscape and feeds it live attention. The Web Audio backend is
// replaced by a recording one, so no AudioContext is created and nothing is heard.

const audio = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../audio/backend.ts", () => ({
  createWebAudioBackend: () => ({
    async start() {
      audio.calls.push("start");
    },
    setVolume() {},
    playCue(cue: string) {
      audio.calls.push(`cue:${cue}`);
    },
    startLoop() {},
    stopLoop() {},
    silence() {
      audio.calls.push("silence");
    },
  }),
}));

const chimes = () => audio.calls.filter((c) => c === "cue:chime");

let urls: string[] = [];

beforeEach(() => {
  audio.calls.length = 0;
  urls = [];
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  // Requests that never answer keep the sync loops parked; the test drives the store directly.
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
  getSoundscape().disable();
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

/** The data sync has started (it reset the store for its project); only then drive the store. */
const settled = () =>
  vi.waitFor(() => expect(urls).toContain(`/v1/projects/${DEFAULT_PROJECT_ID}/snapshot`));

describe("OverlayRoot sound wiring", () => {
  it("is silent before sound is enabled, however much attention arrives", async () => {
    await mount();
    await settled();

    dataStore.setState({ attention: [needsYou("a1")] });
    dataStore.setState({ attention: [] });
    dataStore.setState({ attention: [needsYou("a2")] });
    await new Promise((r) => setTimeout(r, 50));

    expect(audio.calls).toEqual([]);
    expect(getSoundscape().enabled).toBe(false);
  });

  it("chimes once on the fake backend when an agent enters needs-you after enable", async () => {
    await mount();
    await settled();
    dataStore.setState({ attention: [needsYou("a1")] }); // already red when sound is enabled

    await getSoundscape().enable();
    expect(audio.calls).toContain("start");
    expect(chimes()).toHaveLength(0);

    dataStore.setState({ attention: [needsYou("a1"), needsYou("a2")] });
    await vi.waitFor(() => expect(chimes()).toHaveLength(1));

    // The same agents again in a new array, and a drop to trouble: no further chime.
    dataStore.setState({ attention: [needsYou("a1"), needsYou("a2")] });
    dataStore.setState({ attention: [trouble("a1"), needsYou("a2")] });
    await new Promise((r) => setTimeout(r, 50));
    expect(chimes()).toHaveLength(1);
  });

  it("stops feeding the soundscape when OverlayRoot unmounts", async () => {
    const view = await mount();
    await settled();
    await getSoundscape().enable();
    await view.unmount();

    dataStore.setState({ attention: [needsYou("a9")] });
    await new Promise((r) => setTimeout(r, 50));
    expect(chimes()).toHaveLength(0);
  });
});
