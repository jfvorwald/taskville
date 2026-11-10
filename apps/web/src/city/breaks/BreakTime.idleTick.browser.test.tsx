import { afterEach, beforeEach, expect, it } from "vitest";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { lightingController } from "../lighting/instance.ts";
import { type Harness, mountCity, SECOND, WAITING_SINCE } from "./harness.fixture.tsx";

// M9.13 (#497): the break plan's 1 s tick must not cost a frame while nothing visible changes.
// R3F asks for a frame through the root's `invalidate` whenever a React commit applies props, so
// the test counts calls to it. With a working agent seated, no break due, reduced motion (no
// walking) and a pinned clock, several plan ticks must produce no invalidation. The control moves
// the agent onto a break (a real visible change) and must still invalidate.
// Run: pnpm test:browser src/city/breaks/BreakTime.idleTick  (from apps/web)

const TICKS = 4;
let city: Harness | undefined;
beforeEach(() => {
  lightingController.setSetting("always-day");
  getSettingsStore().set("breakTime", true);
});
afterEach(async () => {
  await city?.unmount();
  city = undefined;
  lightingController.setSetting("cycle");
});

/** Counts `invalidate()` calls on the canvas root from now on; the real invalidate still runs. */
function countInvalidations(h: Harness): { count: () => number; stop: () => void } {
  const root = h.root();
  const original = root.invalidate;
  let n = 0;
  root.set({
    invalidate: (frames) => {
      n += 1;
      original(frames);
    },
  });
  return { count: () => n, stop: () => root.set({ invalidate: original }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("requests no frame over several idle plan ticks", async () => {
  const h = await mountCity({ a1: "working" });
  city = h;
  // Let mount-time commits and the first ticks settle, then watch.
  await sleep(2 * SECOND);
  await h.frames(3);
  const probe = countInvalidations(h);
  await sleep((TICKS + 0.5) * SECOND);
  probe.stop();
  expect(probe.count()).toBe(0);
}, 40_000);

it("control: a real visible change (a break starting) still invalidates", async () => {
  const h = await mountCity({ a1: "waiting" });
  city = h;
  await sleep(2 * SECOND);
  const probe = countInvalidations(h);
  // Past the longest break delay (120 s): the agent leaves its workstation for a break.
  h.clock.now = WAITING_SINCE + 125 * SECOND;
  await sleep(2 * SECOND);
  probe.stop();
  expect(probe.count()).toBeGreaterThan(0);
}, 40_000);
