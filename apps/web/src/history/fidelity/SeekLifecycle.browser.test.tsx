import { act } from "react";
import type { InstancedMesh, Mesh, MeshBasicMaterial, Scene } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  type StoredEnvelope,
  storedEnvelopeSchema,
} from "../../../../../packages/protocol/src/index.ts";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { LOG, stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { lightingController } from "../../city/lighting/instance.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { worldAnchors } from "../../overlays/host/index.ts";
import { getSettingsStore } from "../../overlays/settings/index.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { themeController } from "../../themes/core/index.ts";
import { HistoryProvider } from "../ui/HistoryProvider.tsx";
import { CityComposition, position } from "./fixtures/composition.tsx";

const originalTheme = themeController.store.getState();
const originalTime = lightingController.getTime();
const originalReduced = getSettingsStore().getSnapshot().reducedMotion;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
  lightingController.setTime(originalTime);
  getSettingsStore().set("reducedMotion", originalReduced);
  themeController.setTheme(originalTheme.themeId);
  themeController.setHistory(originalTheme.history);
  themeController.setMode(originalTheme.mode);
  worldAnchors.replaceAnchors("agent:", {});
});
const click = (name: string) =>
  act(() =>
    (page.getByRole("button", { name, exact: true }).element() as HTMLButtonElement).click(),
  );
function recording(kind: "tests" | "merge") {
  const specs =
    kind === "tests"
      ? [
          LOG[0],
          { ...LOG[0], type: "test.result", payload: { passed: 0, failed: 1, skipped: 0 } },
          { ...LOG[0], type: "test.result", payload: { passed: 1, failed: 0, skipped: 0 } },
          { ...LOG[0], type: "agent.connected", payload: {} },
        ]
      : [
          LOG[0],
          {
            ...LOG[0],
            type: "git.merge",
            payload: {
              repo: "seek-lifecycle",
              sha: "a".repeat(40),
              parents: ["b".repeat(40), "c".repeat(40)],
            },
          },
          { ...LOG[0], type: "agent.connected", payload: {} },
        ];
  return specs.map((spec, index) => {
    const at = new Date(
      Date.parse("2026-10-30T12:00:00Z") + (index === specs.length - 1 ? 600_000 : index * 500),
    ).toISOString();
    return storedEnvelopeSchema.parse({
      ...spec,
      ingestSequence: index + 1,
      eventId: `00000000-0000-4000-8007-${String(index + 1).padStart(12, "0")}`,
      sourceEventId: `seek-lifecycle-${index + 1}`,
      occurredAt: at,
      receivedAt: at,
    });
  });
}
async function mount(log: StoredEnvelope[]) {
  const transport = timelineEngine(log);
  let failedAt: number | undefined;
  let deferred = false;
  const pending: Array<() => void> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get(SESSION_HEADER)).toBe(SECRET);
    if (url.pathname.endsWith("/state")) {
      if (Number(url.searchParams.get("at")) === failedAt)
        return Promise.resolve(new Response(null, { status: 503 }));
      // Ignore abort intentionally: an older seek must not change current-seek suppression.
      if (deferred)
        return new Promise<Response>((resolve, reject) =>
          pending.push(() => {
            void transport.fetcher(input, init).then(resolve, reject);
          }),
        );
    }
    return transport.fetcher(input, init);
  });
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(1, log));
  getSettingsStore().set("reducedMotion", "off");
  let scene: Scene | undefined;
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <CityComposition
          onScene={(value) => {
            scene = value;
          }}
        />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  const merge = () => {
    let result: InstancedMesh | undefined;
    scene?.traverse((object) => {
      if ((object as InstancedMesh).isInstancedMesh && (object as InstancedMesh).count === 60)
        result = object as InstancedMesh;
    });
    return result;
  };
  const shimmer = () => {
    const found: Mesh[] = [];
    scene?.traverse((object) => {
      const mesh = object as Mesh;
      if (
        mesh.isMesh &&
        !(mesh as InstancedMesh).isInstancedMesh &&
        (mesh.material as MeshBasicMaterial).color?.getHexString() === "4ade80" &&
        mesh.geometry.type === "PlaneGeometry"
      )
        found.push(mesh);
    });
    expect(found).toHaveLength(1);
    return found[0];
  };
  await expect.poll(() => merge()).toBeDefined();
  return {
    pending,
    defer: () => {
      deferred = true;
    },
    fail: (at?: number) => {
      failedAt = at;
    },
    merge: () => merge()?.visible,
    shimmer: () => shimmer().visible,
  };
}

it("a failed seek preserves the displayed red-test baseline for resumed green shimmer", async () => {
  const log = recording("tests");
  const rig = await mount(log);
  click("History");
  await position(4);
  click("Previous moment");
  await position(3);
  click("Previous moment");
  await position(2);
  expect(rig.shimmer()).toBe(false);
  rig.fail(3);
  click("Next moment");
  await expect
    .element(page.getByRole("status").filter({ hasText: "Could not load recorded state." }))
    .toBeVisible();
  await position(2);
  expect(rig.shimmer()).toBe(false);
  rig.fail();
  click("Play");
  await position(3);
  expect(dataStore.getState().state?.head).toBe(1);
  await expect.poll(rig.shimmer).toBe(true);
});

it("a superseded seek settling cannot turn the current explicit seek into a playback celebration", async () => {
  const rig = await mount(recording("merge"));
  click("History");
  await position(3);
  click("Previous moment");
  await position(2);
  click("Previous moment");
  await position(1);
  expect(rig.merge()).toBe(false);
  rig.defer();
  click("Next moment");
  await expect.poll(() => rig.pending.length).toBe(1);
  click("Next moment");
  await expect.poll(() => rig.pending.length).toBe(2);
  await act(async () => {
    rig.pending[0]();
    await Promise.resolve();
    await Promise.resolve();
  });
  click("Play");
  await act(async () => {
    rig.pending[1]();
  });
  await position(2);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(rig.merge()).toBe(false);
  expect(dataStore.getState().state?.head).toBe(1);
});
