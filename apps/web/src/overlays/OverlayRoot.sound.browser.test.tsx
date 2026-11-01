import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { needsYou, trouble } from "../../test/audio/fakes.ts";
import { getSoundscape } from "../audio/index.ts";
import { selectionStore } from "../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../data/project.ts";
import { dataStore } from "../data/store.ts";
import { SessionProvider } from "../pairing/session.tsx";
import type { AttentionFeed } from "./header/attention.ts";
import { attentionStore } from "./header/attentionSync.ts";
import { OverlayRoot } from "./index.tsx";

// M4.09 wiring: the soundscape core is unit tested with fakes, but nothing mounted OverlayRoot and
// checked that it creates the soundscape and feeds it live attention. The Web Audio backend is
// replaced by a recording one, so no AudioContext is created and nothing is heard.
//
// roborev 5949: the needs-you chime comes from the global attention feed (`attentionStore`, all
// projects, ARCHITECTURE 2.8), not from the selected project's data store. The tests drive the
// feed the way the engine's snapshot does: `{ feed, ready: true }`.

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

const OTHER = "other-project";
const project = (projectId: string, ...agents: string[]) => ({
  projectId,
  name: projectId,
  attention: agents.map((a) => needsYou(a)),
});
const feedOf = (...projects: ReturnType<typeof project>[]): AttentionFeed =>
  Object.fromEntries(projects.map((p) => [p.projectId, p]));
const snapshot = (...projects: ReturnType<typeof project>[]) =>
  attentionStore.setState({ feed: feedOf(...projects), ready: true });

let urls: string[] = [];

beforeEach(() => {
  audio.calls.length = 0;
  urls = [];
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  attentionStore.setState({ feed: {}, ready: false });
  // Requests that never answer keep the sync loops parked; the test drives the stores directly.
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
  attentionStore.setState({ feed: {}, ready: false });
});

const mount = () =>
  render(
    <SessionProvider value="test-session">
      <OverlayRoot />
    </SessionProvider>,
  );

/** The data sync has started (it reset the store for its project); only then drive the stores. */
const settled = () =>
  vi.waitFor(() => expect(urls).toContain(`/v1/projects/${DEFAULT_PROJECT_ID}/snapshot`));

describe("OverlayRoot sound wiring", () => {
  it("is silent before sound is enabled, however much attention arrives", async () => {
    await mount();
    await settled();

    snapshot(project(OTHER, "a1"));
    snapshot();
    snapshot(project(DEFAULT_PROJECT_ID, "a2"));
    await new Promise((r) => setTimeout(r, 50));

    expect(audio.calls).toEqual([]);
    expect(getSoundscape().enabled).toBe(false);
  });

  it("chimes once when an agent enters needs-you in a project that is not selected", async () => {
    await mount();
    await settled();
    snapshot(project(OTHER, "a1")); // already red when sound is enabled

    await getSoundscape().enable();
    expect(audio.calls).toContain("start");
    expect(chimes()).toHaveLength(0);

    snapshot(project(OTHER, "a1", "a2"));
    await vi.waitFor(() => expect(chimes()).toHaveLength(1));

    // The same agents again in a new feed, and a drop to trouble: no further chime.
    snapshot(project(OTHER, "a1", "a2"));
    snapshot({ projectId: OTHER, name: OTHER, attention: [trouble("a1"), needsYou("a2")] });
    await new Promise((r) => setTimeout(r, 50));
    expect(chimes()).toHaveLength(1);
  });

  it("chimes once for an agent in the selected project too, through the same feed", async () => {
    await mount();
    await settled();
    snapshot();
    await getSoundscape().enable();

    snapshot(project(DEFAULT_PROJECT_ID, "a1"));

    await vi.waitFor(() => expect(chimes()).toHaveLength(1));
  });

  it("does not chime when the first snapshot arrives after sound was enabled", async () => {
    await mount();
    await settled();
    await getSoundscape().enable();

    snapshot(project(OTHER, "a1"), project(DEFAULT_PROJECT_ID, "a2"));
    await new Promise((r) => setTimeout(r, 50));

    expect(chimes()).toHaveLength(0);
  });

  it("does not chime when only the shown project changes, even if its stream has a waiting agent", async () => {
    await mount();
    await settled();
    snapshot(project(OTHER, "a1")); // waiting in the project we are about to switch to
    await getSoundscape().enable();

    selectProject(OTHER);
    await vi.waitFor(() => expect(urls).toContain(`/v1/projects/${OTHER}/snapshot`));
    // The new project's own stream delivers the agent that is already waiting.
    dataStore.setState({ attention: [needsYou("a1")] });
    await new Promise((r) => setTimeout(r, 50));

    expect(chimes()).toHaveLength(0);
  });

  it("does not chime for the selected project's data store alone: the feed decides", async () => {
    await mount();
    await settled();
    snapshot();
    await getSoundscape().enable();

    dataStore.setState({ attention: [needsYou("a1")] });
    await new Promise((r) => setTimeout(r, 50));

    expect(chimes()).toHaveLength(0);
  });

  it("stops feeding the soundscape when OverlayRoot unmounts", async () => {
    const view = await mount();
    await settled();
    snapshot();
    await getSoundscape().enable();
    await view.unmount();

    snapshot(project(OTHER, "a9"));
    await new Promise((r) => setTimeout(r, 50));
    expect(chimes()).toHaveLength(0);
  });
});
