import { act } from "react";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { needsYou } from "../../../test/audio/fakes.ts";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { getSoundscape } from "../../audio/index.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { attentionStore } from "../../overlays/header/attentionSync.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { SceneRoot } from "../../SceneRoot.tsx";
import { themeController } from "../../themes/core/index.ts";
import { HistoryProvider } from "./HistoryProvider.tsx";

const audio = vi.hoisted(() => ({ cues: [] as string[] }));
vi.mock("../../audio/backend.ts", () => ({
  createWebAudioBackend: () => ({
    async start() {},
    setVolume() {},
    playCue(cue: string) {
      audio.cues.push(cue);
    },
    startLoop() {},
    stopLoop() {},
    silence() {},
  }),
}));
vi.mock("../../audio/loops.ts", () => ({ loadAmbientLoop: async () => new ArrayBuffer(0) }));

it("keeps the pill separate from the real header and receives one live chime in the full scene", async () => {
  const transport = timelineEngine();
  const paths: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    paths.push(url.pathname);
    if (url.pathname.includes("/timelines")) return transport.fetcher(input, init);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
  const previousStyle = document.documentElement.getAttribute("style");
  const detachTheme = themeController.attach(document.documentElement);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  selectProject(PROJECT);
  selectionStore.select(null);
  attentionStore.setState({ ready: false, feed: {} });
  audio.cues.length = 0;
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <SceneRoot />
      </HistoryProvider>
    </SessionProvider>,
  );
  const feed = (...ids: string[]) =>
    act(() =>
      attentionStore.setState({
        ready: true,
        feed: {
          [PROJECT]: {
            projectId: PROJECT,
            name: "Project",
            attention: ids.map((id) => needsYou(id)),
          },
        },
      }),
    );
  try {
    await vi.waitFor(() => expect(paths).toContain(`/v1/projects/${PROJECT}/snapshot`));
    act(() => dataStore.getState().applySnapshotState(stateAt(2)));
    feed("already");
    await getSoundscape().enable();
    expect(audio.cues).toEqual([]);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect.element(page.getByRole("slider", { name: "Timeline time" })).toBeVisible();
    const pill = page.getByRole("button", { name: /^Back to live/ });
    await expect.element(pill).toBeVisible();
    const header = document.querySelector('[data-slot="header"]');
    expect(header).not.toBeNull();
    const bounds = header?.getBoundingClientRect();
    const button = pill.element().getBoundingClientRect();
    expect
      .soft(button.top, "pill has its own band below the complete production header")
      .toBeGreaterThanOrEqual((bounds?.bottom ?? 0) + 8);
    expect(Math.abs(button.left + button.width / 2 - window.innerWidth / 2)).toBeLessThanOrEqual(2);
    feed("already", "new-live");
    await expect.element(pill).toHaveAccessibleName("Back to live · 2 needs you");
    await vi.waitFor(() => expect(audio.cues).toEqual(["chime"]));
    feed("already", "new-live");
    expect(audio.cues).toEqual(["chime"]);
    act(() =>
      attentionStore.setState({
        ready: true,
        feed: Object.fromEntries(
          Array.from({ length: 6 }, (_, i) => [
            `other-${i}`,
            {
              projectId: `other-${i}`,
              name: `Workspace ${i} needs live attention`,
              attention: [needsYou(`agent-${i}`)],
            },
          ]),
        ),
      }),
    );
    await expect.element(pill).toHaveAccessibleName("Back to live · 6 needs you");
    await expect
      .poll(() => header?.getBoundingClientRect().bottom)
      .toBeGreaterThan(bounds?.bottom ?? 0);
    await expect
      .poll(
        () =>
          pill.element().getBoundingClientRect().top -
          (header?.getBoundingClientRect().bottom ?? 0),
      )
      .toBeGreaterThanOrEqual(8);
    expect(audio.cues).toEqual(["chime", "chime"]);
    await pill.click();
    await expect
      .element(page.getByRole("slider", { name: "Timeline time" }))
      .not.toBeInTheDocument();
  } finally {
    await view.unmount();
    getSoundscape().disable();
    detachTheme();
    if (previousStyle === null) document.documentElement.removeAttribute("style");
    else document.documentElement.setAttribute("style", previousStyle);
    vi.unstubAllGlobals();
    attentionStore.setState({ ready: false, feed: {} });
    dataStore.getState().reset(DEFAULT_PROJECT_ID);
    selectProject(DEFAULT_PROJECT_ID);
    selectionStore.select(null);
    await page.viewport(viewport.width, viewport.height);
  }
});
