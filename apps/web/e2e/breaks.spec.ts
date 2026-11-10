import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { CALM, type ProducerOptions, runProducer } from "../../../packages/demo/src/index.ts";
import { EngineClient, readToken } from "../../cli/src/client.ts";
import { CODES_FILE } from "./codes.ts";

// M9.07: break time over the `breaks` demo scenario, against a real engine and the built client.
//
// Clock: break delay (60 to 120 s after a waiting record began) runs on the store clock, which in
// the browser is wall time. `taskville demo --speed N` stamps an event at
// `startAtMs + floor(atMs / N)`, so events never run ahead of wall time and a faster speed only
// brings the scenario sooner. The delay itself is not compressed, so the speed has to leave the
// breaks room to start before Cyd gets work back.
// This spec runs the same producer the CLI runs (runProducer, scenario "breaks", seed 7) in
// process at 2x, with no backdate: stamps equal posting times. The five turn_ended records
// (scenario 182 to 233 s) land at 91 to 117 s of wall time, so every break has started by 237 s
// at the latest. Cyd's prompt (scenario 562 s) lands at 281 s, after Cyd's break (44 s of margin),
// and Brook's needs-you (scenario 613 s) at 306 s, stamped at its posting time so its bubble
// window opens while the request is open. The run takes about 6 minutes; the budgets below follow.
//
// Also measures idle fps with agents standing on break (headless SwiftShader, so a worst case):
// the WebGL draw rate over 10 s once nobody travels and the producer is stopped.

const port = Number(process.env.E2E_PORT ?? 4817);
const SPEED = 2;
const SLEEPERS = ["Ada", "Cyd", "Dee", "Eli", "Fay"];

interface Walker {
  id: string;
  x: number;
  z: number;
  state: string;
  onTheWay: boolean;
  slotId: string | null;
  queued: boolean;
  gone: boolean;
}

interface Row {
  id: string;
  name: string;
  status: string;
  onBreak: boolean;
  state: string;
  urgent: boolean;
}

const rows = (page: Page): Promise<Row[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=agent-label]")].map((el) => ({
      id: el.dataset.agentId ?? "",
      name: el.querySelector("span")?.textContent ?? "",
      status: el.children[1]?.textContent ?? "",
      onBreak: el.querySelector("[data-testid=agent-label-on-break]") !== null,
      state: el.dataset.state ?? "",
      urgent: el.dataset.urgent === "true",
    })),
  );

const walkers = (page: Page): Promise<Walker[]> =>
  page.evaluate(() =>
    (window as unknown as { __taskvilleMovement: () => Walker[] }).__taskvilleMovement(),
  );

const bubbles = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=quip-bubble]")].map((el) => ({
      level: el.dataset.level ?? "",
      text: el.textContent ?? "",
    })),
  );

test("breaks start, chat, end on work, and give way to needs-you; idle fps on break", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.addInitScript(() => {
    // Records, as the DOM changes, when a needs-you bubble shows (its window is only 4 s) and
    // each urgent label's name and whether it was marked on break, so the check does not depend
    // on when the test happens to poll.
    const seen = {
      needsYouBubbles: [] as string[],
      urgent: [] as { name: string; onBreak: boolean }[],
    };
    (window as unknown as { __tvSeen: typeof seen }).__tvSeen = seen;
    const scan = () => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-testid=quip-bubble]")) {
        if (
          el.dataset.level === "needs_you" &&
          !seen.needsYouBubbles.includes(el.textContent ?? "")
        )
          seen.needsYouBubbles.push(el.textContent ?? "");
      }
      for (const el of document.querySelectorAll<HTMLElement>(
        "[data-testid=agent-label][data-urgent=true]",
      )) {
        const name = el.querySelector("span")?.textContent ?? "";
        const onBreak = el.querySelector("[data-testid=agent-label-on-break]") !== null;
        if (!seen.urgent.some((u) => u.name === name && u.onBreak === onBreak))
          seen.urgent.push({ name, onBreak });
      }
    };
    new MutationObserver(scan).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await page.addInitScript(() => {
    // Draw counter for the idle fps step: a frame counts when WebGL drew since the last rAF.
    // While `__tvWatch` is on it also records, every animation frame, each agent the render
    // pacer counts as moving (walking, arriving, departing or on its way), so a sample that a
    // walk overlapped is known even when the walk is shorter than any poll interval.
    const w = window as unknown as {
      __tvFrames: number[];
      __tvWatch: boolean;
      __tvMoved: string[];
      __taskvilleMovement?: () => { id: string; state: string; onTheWay: boolean; gone: boolean }[];
    };
    w.__tvFrames = [];
    w.__tvWatch = false;
    w.__tvMoved = [];
    let drew = false;
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      for (const name of [
        "drawElements",
        "drawArrays",
        "drawElementsInstanced",
        "drawArraysInstanced",
      ] as const) {
        const table = proto as unknown as Record<string, unknown>;
        const original = table[name] as ((...args: unknown[]) => void) | undefined;
        if (typeof original !== "function") continue;
        table[name] = function (...args: unknown[]) {
          drew = true;
          return original.apply(this, args);
        };
      }
    }
    const tick = (t: number) => {
      if (drew) {
        w.__tvFrames.push(t);
        drew = false;
      }
      if (w.__tvWatch) {
        for (const a of w.__taskvilleMovement?.() ?? []) {
          const moving =
            !a.gone &&
            (a.onTheWay ||
              a.state === "walking" ||
              a.state === "arriving" ||
              a.state === "departing");
          if (moving && !w.__tvMoved.includes(a.id)) w.__tvMoved.push(a.id);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const { breaks, home } = JSON.parse(readFileSync(CODES_FILE, "utf8")) as {
    breaks: string;
    home: string;
  };
  await page.goto(`/#pair=${breaks}`);
  await expect(page.getByTestId("scene-root")).toBeVisible();
  await page.goto("/?debug=movement");
  await expect(page.getByTestId("scene-root")).toBeVisible();

  const stop = new AbortController();
  const client = new EngineClient({ url: `http://127.0.0.1:${port}`, token: readToken(home) });
  const t0 = Date.now();
  const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);
  const producer = runProducer({
    seed: 7,
    pace: CALM,
    projectId: "unsorted",
    scenario: "breaks",
    speed: SPEED,
    startAtMs: Date.now(),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stop: () => stop.signal.aborted,
    post: (batch) =>
      client.json<Awaited<ReturnType<ProducerOptions["post"]>>>("POST", "/v1/events/batch", batch),
  });
  const producerError: unknown[] = [];
  producer.catch((e) => producerError.push(e));

  try {
    // All five sleepers have a label (Brook too).
    const labels = page.getByTestId("agent-label");
    await expect(labels).toHaveCount(6, { timeout: 60_000 });

    // (1) A waiting agent leaves its slot for a break spot; its label says "on break" and still
    // says Waiting.
    const onBreakNow = async () =>
      (await rows(page)).filter((r) => r.onBreak && SLEEPERS.includes(r.name));
    await expect
      .poll(async () => (await onBreakNow()).length, { timeout: 240_000, intervals: [500] })
      .toBeGreaterThan(0);
    const first = (await onBreakNow())[0] as Row;
    log(`first on break: ${first.name} (${first.status}, ${first.state})`);
    expect(first.status).toBe("Waiting");
    // It stands at a break spot: not on a workstation slot.
    // The agent must be in the movement snapshot: a missing walker is a failure, not "no slot".
    await expect
      .poll(
        async () => {
          const walker = (await walkers(page)).find((w) => w.id === first.id);
          return walker === undefined ? "missing" : (walker.slotId ?? "none");
        },
        { timeout: 60_000 },
      )
      .toBe("none");

    // (2) Two or more agents on break settle and a chatter bubble shows.
    await expect
      .poll(async () => (await bubbles(page)).some((b) => b.level === "chatter"), {
        timeout: 90_000,
        intervals: [500],
      })
      .toBe(true);
    log(`bubbles: ${JSON.stringify(await bubbles(page))}`);
    // A chatter bubble means a conversation between two agents on break, so at least two labels
    // say "on break" while it shows. One sample can land between label updates (it read 1 in a
    // wave run), so poll for two within a window around the chatter instead of reading once.
    await expect
      .poll(async () => new Set((await onBreakNow()).map((r) => r.name)).size, {
        timeout: 20_000,
        intervals: [250],
      })
      .toBeGreaterThanOrEqual(2);

    // (3) The scenario gives Cyd work back: its break ends at once (label and status), and it walks
    // to its area. Deadlines are measured from the producer start (t0), not from the previous step:
    // Cyd's prompt is scenario 562 s / SPEED = 281 s of wall time, and every break has started by
    // 237 s (see the clock note above).
    const sinceStart = () => Date.now() - t0;
    const untilStart = (deadlineMs: number) => Math.max(15_000, deadlineMs - sinceStart());
    const CYD_PROMPT_MS = 562_000 / SPEED;
    const cydRow = async () => (await rows(page)).find((r) => r.name === "Cyd");
    // Cyd is on break (and still Waiting) before the resume, so the step cannot pass without a break.
    await expect
      .poll(async () => (await cydRow())?.onBreak ?? false, {
        timeout: untilStart(CYD_PROMPT_MS - 5_000),
        intervals: [250],
      })
      .toBe(true);
    expect((await cydRow())?.status).toBe("Waiting");
    log(`Cyd on break: ${JSON.stringify(await cydRow())}`);
    await expect
      .poll(async () => (await cydRow())?.status ?? "", {
        timeout: untilStart(CYD_PROMPT_MS + 60_000),
        intervals: [250],
      })
      .not.toBe("Waiting");
    const cyd = (await cydRow()) as Row;
    log(`Cyd works again: ${JSON.stringify(cyd)}`);
    expect(cyd.onBreak).toBe(false);
    // The scenario emits activity, so Cyd has an area: a known status and a workstation or a place
    // in line, not the plaza.
    expect(cyd.status).not.toBe("Unknown");
    await expect
      .poll(
        async () => {
          const w = (await walkers(page)).find((x) => x.id === cyd.id);
          return w !== undefined && (w.slotId !== null || w.queued);
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
    await expect
      .poll(async () => (await walkers(page)).find((x) => x.id === cyd.id)?.onTheWay, {
        timeout: 60_000,
        intervals: [500],
      })
      .toBe(false);
    await page.waitForTimeout(3_000);
    expect((await rows(page)).find((r) => r.id === cyd.id)?.onBreak).toBe(false);
    // The others are still on break while Cyd works.
    expect((await onBreakNow()).length).toBeGreaterThan(0);

    // (4) Brook raises a needs-you: its label goes urgent and a needs_you bubble shows (recorded
    // by the in-page observer, whichever step the test was on), and it is never marked on break.
    const seenOf = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __tvSeen: { needsYouBubbles: string[]; urgent: { name: string; onBreak: boolean }[] };
            }
          ).__tvSeen,
      );
    await expect
      .poll(async () => (await seenOf()).needsYouBubbles.length, {
        timeout: 120_000,
        intervals: [500],
      })
      .toBeGreaterThan(0);
    const seen = await seenOf();
    log(`needs-you seen: ${JSON.stringify(seen)}`);
    expect(seen.urgent.map((u) => u.name)).toContain("Brook");
    expect(seen.urgent.filter((u) => u.onBreak)).toEqual([]);

    // Idle fps with agents on break: stop the producer, let everyone settle, sample 10 s.
    stop.abort();
    await producer.catch(() => {});
    expect(producerError, String(producerError[0])).toEqual([]);
    // The sample must cover a scene where nothing moves. A walking agent puts the render pacer at
    // full rate (by design), which headless SwiftShader renders at about 27 to 30 fps. Settling
    // first is not enough: break activities last 2 to 5 minutes and the next one can send an agent
    // walking to another spot in the middle of the sample (M9.12: CI read 26.3 and 27.2 fps that
    // way, locally a walk inside the window read 23.4 and 27.3). So each 10 s window records, every
    // animation frame, whether anyone moved, and a window someone moved in is discarded and taken
    // again after a fresh settle, within a bounded deadline; missing it fails the step rather than
    // reporting a moving scene as idle.
    const SETTLE_MS = 5_000;
    const SAMPLE_MS = 10_000;
    const RESAMPLE_DEADLINE_MS = 120_000;
    // The same states the pacer counts as agents moving (`motionSignals`), plus on its way.
    const isMoving = (w: Walker) =>
      !w.gone && (w.onTheWay || ["walking", "arriving", "departing"].includes(w.state));
    // Pointer activity holds the full rate for a second, so move the pointer away before settling.
    await page.mouse.move(0, 0);
    const settle = async () => {
      let stillSince: number | undefined;
      await expect
        .poll(
          async () => {
            const moving = (await walkers(page)).filter(isMoving).length;
            if (moving > 0) {
              stillSince = undefined;
              return false;
            }
            stillSince ??= Date.now();
            return Date.now() - stillSince >= SETTLE_MS;
          },
          { timeout: 90_000, intervals: [250] },
        )
        .toBe(true);
    };
    const sampleUntil = Date.now() + RESAMPLE_DEADLINE_MS;
    let sample: { frames: number; seconds: number; standing: number } | undefined;
    for (let attempt = 1; sample === undefined; attempt++) {
      if (attempt > 1 && Date.now() > sampleUntil) {
        throw new Error(
          `no ${SAMPLE_MS / 1000} s window without an agent moving within ${RESAMPLE_DEADLINE_MS / 1000} s`,
        );
      }
      await settle();
      // The sample only means something with at least two agents standing on break.
      const standing = (await onBreakNow()).length;
      expect(standing).toBeGreaterThanOrEqual(2);
      const { start, watching } = await page.evaluate(() => {
        const w = window as unknown as {
          __tvFrames: number[];
          __tvWatch: boolean;
          __tvMoved: string[];
          __taskvilleMovement?: unknown;
        };
        w.__tvFrames.length = 0;
        w.__tvMoved = [];
        w.__tvWatch = true;
        return {
          start: performance.now(),
          watching: typeof w.__taskvilleMovement === "function",
        };
      });
      // Without the movement hook the in-window check would pass without looking.
      expect(watching).toBe(true);
      await page.waitForTimeout(SAMPLE_MS);
      const window_ = await page.evaluate(() => {
        const w = window as unknown as {
          __tvFrames: number[];
          __tvWatch: boolean;
          __tvMoved: string[];
        };
        w.__tvWatch = false;
        return { frames: w.__tvFrames.length, end: performance.now(), moved: [...w.__tvMoved] };
      });
      const seconds = (window_.end - start) / 1000;
      if (window_.moved.length > 0) {
        console.log(
          `IDLE_FPS window ${attempt} discarded: ${window_.moved.join(", ")} moved during it (${(window_.frames / seconds).toFixed(1)} fps)`,
        );
        continue;
      }
      sample = { frames: window_.frames, seconds, standing };
    }
    const { frames, seconds, standing } = sample;
    const fps = frames / seconds;
    console.log(
      `IDLE_FPS ${fps.toFixed(1)} (${frames} frames in ${seconds.toFixed(1)} s, ${standing} agents on break, headless SwiftShader)`,
    );
    // Budget (ARCHITECTURE 11): 20 fps when nothing moves; allow a little headroom.
    expect(fps).toBeLessThan(25);
  } finally {
    stop.abort();
  }
});
