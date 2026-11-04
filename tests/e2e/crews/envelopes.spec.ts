import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Engine, postHook, readRecording, startEngine, TEAM_FIXTURE } from "./harness.ts";
import { expect, test } from "./playwright.ts";

// M5.04 (#63) clip: the recorded in-process team (fixtures/claude-code/team/in-process.jsonl) is
// replayed untouched through the telemetry route with video on, and a paper envelope must appear
// for a teammate message. No model, no live `claude`, nothing under ~/.claude.
//
// The envelope is a 3D object with no DOM of its own, so the spec finds it the way a user does:
// it sweeps the pointer over the canvas and waits for the hover tooltip ("who to whom"). The sweep
// runs inside the page as synthetic pointermoves on the canvas, because the envelope is only in
// flight for about two seconds.

const OUT = process.env.ENVELOPES_OUT ?? join(import.meta.dirname, "test-results", "envelopes");
const FIRST_MESSAGE_SEQ = 40; // pip's SendMessage to bo; the crew mapper emits team.message on its PostToolUse
const STEP_PX = 6;

let engine: Engine;

test.afterAll(async () => {
  test.setTimeout(30_000);
  await engine?.stop();
});

test("a teammate message flies as an envelope that says who wrote to whom", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  engine = await startEngine();
  const context = await browser.newContext({
    baseURL: engine.url,
    viewport: { width: 1000, height: 640 },
    recordVideo: { dir: OUT, size: { width: 800, height: 512 } },
  });
  const page = await context.newPage();
  await page.goto(`/#pair=${engine.pairingCode}`);
  await expect(page.getByTestId("scene-root")).toBeVisible({ timeout: 20_000 });

  const recording = readRecording(TEAM_FIXTURE);
  for (const h of recording.filter((r) => r.seq < FIRST_MESSAGE_SEQ)) await postHook(engine, h);
  await expect(
    page.getByTestId("agent-list").locator('[data-agent-id$=":apip-5cb5e9bb3f2f1097"]'),
  ).toBeVisible({
    timeout: 15_000,
  });
  // Let the bots settle at their places so the envelope has anchors to fly between.
  await page.waitForTimeout(2_500);

  const sweep = () =>
    page.evaluate((step) => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) return null;
      const rect = canvas.getBoundingClientRect();
      for (let y = rect.top + 2; y < rect.bottom; y += step) {
        for (let x = rect.left + 2; x < rect.right; x += step) {
          canvas.dispatchEvent(
            new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }),
          );
          const tip = document.querySelector('[role="tooltip"]');
          if (tip?.textContent) return tip.textContent;
        }
      }
      return null;
    }, STEP_PX);

  const sent = recording.find((r) => r.seq === FIRST_MESSAGE_SEQ);
  if (sent === undefined) throw new Error("recording has no seq 40");
  await postHook(engine, sent);
  let label: string | null = null;
  for (let i = 0; i < 10 && label === null; i++) label = await sweep();
  expect(label, "an envelope tooltip appears for the message").toMatch(/\bto\b/);
  console.log(`envelope tooltip: ${label}`);

  await page.waitForTimeout(2_500); // let the clip show the envelope land
  const video = page.video();
  await context.close();
  await video?.saveAs(join(OUT, "envelopes-e2e.webm"));
});
