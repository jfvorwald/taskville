import {
  agentIdOf,
  denyBodyWith,
  eventsOfType,
  HOLD_WINDOW_SECONDS,
  type HookAnswer,
  holdHook,
  type PermissionEngine,
  recordedAllowBody,
  recordedPermissionRequest,
  registerSession,
  startPermissionEngine,
} from "./harness.ts";
import { type Browser, type BrowserContext, expect, type Page, test } from "./playwright.ts";

// M4.10 (#69) replay: a real `taskville serve --headless` (hold window of a few seconds), the real
// built web client in a real browser, and a fake Claude Code that POSTs the recorded spike S-1
// PermissionRequest payload to the bridge route with the bridge token and keeps the connection
// open. ARCHITECTURE.md 8.1, 9 and 14 (M4 done when); decisions #116 (D1 to D4) and #271 (D2).
//
// The action card (M4.07, #62) is addressed only through the markers pinned in
// apps/web/src/overlays/action-card/ActionCard.browser.test.tsx: `data-testid="action-card"` with
// `data-state` (open | sent | answered_elsewhere | expired | closed) and `data-variant`
// (decision | open-only), `action-card-input`, the buttons "Allow once", "Deny", "Open session",
// and a note textbox named /note/i.
//
// The session runs in a folder no project covers, so the engine files it under the built-in
// `unsorted` project, which is the project the client shows until the viewer picks another.
//
// Needs the built client in apps/web/dist. Run it with the commands in README.md.

const SESSION_ID = String(recordedPermissionRequest("/").session_id);
const AGENT_ID = agentIdOf(SESSION_ID);
const COMMAND_TEXT = "touch exp1.txt";

let engine: PermissionEngine;
let context: BrowserContext | undefined;

test.beforeEach(async () => {
  engine = await startPermissionEngine();
});

test.afterEach(async () => {
  await context?.close();
  context = undefined;
  await engine?.stop();
});

/** Pairs a fresh browser to the engine and waits until the city shows the session's agent. */
async function openCity(browser: Browser): Promise<Page> {
  context = await browser.newContext({ baseURL: engine.url });
  const page = await context.newPage();
  await page.goto(`/#pair=${engine.pairingCode}`);
  await expect(page.getByTestId("scene-root")).toBeVisible({ timeout: 20_000 });
  await registerSession(engine, SESSION_ID);
  await expect(agentRow(page)).toBeVisible({ timeout: 30_000 });
  return page;
}

// The list row, not the world label (it carries the same attribute but the canvas takes the clicks).
const agentRow = (page: Page) =>
  page.getByTestId("agent-list").locator(`[data-agent-id="${AGENT_ID}"]`);
const card = (page: Page) => page.getByTestId("action-card");

/** The hook Claude Code sends when it is about to show a Bash permission dialog. */
const raiseRequest = () => holdHook(engine, recordedPermissionRequest(engine.cwd));

/** The agent turned red (needs you) and its card is open for the selected agent. */
async function openCard(page: Page): Promise<void> {
  await expect(agentRow(page)).toHaveAttribute("data-urgent", "true", { timeout: 15_000 });
  await agentRow(page).click();
  // The list selection reached the city, so the card has an agent to open for.
  await expect(page.getByTestId("camera-controls")).toHaveAttribute("data-selected-id", AGENT_ID);
  await expect(card(page)).toBeVisible({ timeout: 10_000 });
}

const allow = (page: Page) => page.getByRole("button", { name: "Allow once", exact: true });
const deny = (page: Page) => page.getByRole("button", { name: "Deny", exact: true });
const openSession = (page: Page) => page.getByRole("button", { name: "Open session", exact: true });

async function settled(answer: Promise<HookAnswer>, ms = 10_000): Promise<HookAnswer> {
  return await Promise.race([
    answer,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`the hook was not answered within ${ms} ms`)), ms),
    ),
  ]);
}

test("a held permission request turns the agent red and the card shows the exact input", async ({
  browser,
}) => {
  const page = await openCity(browser);
  const hook = raiseRequest();

  await openCard(page);
  await expect(card(page)).toHaveAttribute("data-state", "open");
  await expect(card(page)).toHaveAttribute("data-variant", "decision");
  await expect(page.getByTestId("action-card-input")).toContainText(COMMAND_TEXT);
  await expect(allow(page)).toBeEnabled();
  await expect(deny(page)).toBeEnabled();
  await expect(openSession(page)).toBeEnabled();

  // Nothing was decided: the hook is still held and the engine recorded no command.
  expect(eventsOfType(engine.home, "command.requested")).toHaveLength(0);
  hook.abort();
});

test("Allow once answers the held hook with the allow JSON and the card says Sent, unconfirmed", async ({
  browser,
}) => {
  const page = await openCity(browser);
  const hook = raiseRequest();
  await openCard(page);

  await allow(page).click();

  const answer = await settled(hook.answer);
  expect(answer.status).toBe(200);
  expect(answer.json).toEqual(recordedAllowBody());
  await expect(card(page)).toHaveAttribute("data-state", "sent");
  await expect(card(page)).toContainText(/sent, unconfirmed/i);
  expect(eventsOfType(engine.home, "command.delivered")).toHaveLength(1);
});

test("Deny with a note answers the held hook with a deny that carries the note", async ({
  browser,
}) => {
  const page = await openCity(browser);
  const hook = raiseRequest();
  await openCard(page);

  const note = "use the dry run flag first";
  await page.getByRole("textbox", { name: /note/i }).fill(note);
  await deny(page).click();

  const answer = await settled(hook.answer);
  expect(answer.status).toBe(200);
  expect(answer.json).toEqual(denyBodyWith(note));
  await expect(card(page)).toHaveAttribute("data-state", "sent");
  await expect(card(page)).toContainText(/sent, unconfirmed/i);
  expect(eventsOfType(engine.home, "command.delivered")).toHaveLength(1);
});

test("with no viewer connected the hook gets the empty 2xx and nothing is decided", async () => {
  // No browser is paired, so no stream is open on the project: the bridge does not hold the hook.
  await registerSession(engine, SESSION_ID);
  const hook = raiseRequest();

  const answer = await settled(hook.answer, 5_000);
  expect(answer.status).toBeGreaterThanOrEqual(200);
  expect(answer.status).toBeLessThan(300);
  expect(answer.text).toBe("");
  // It fell through at once, not after the hold window.
  expect(answer.elapsedMs).toBeLessThan(HOLD_WINDOW_SECONDS * 1000);

  // The agent still turned red (the request was recorded) but nothing was decided or sent.
  expect(eventsOfType(engine.home, "request.opened")).toHaveLength(1);
  expect(eventsOfType(engine.home, "request.resolved")).toHaveLength(0);
  expect(eventsOfType(engine.home, "command.requested")).toHaveLength(0);
  expect(eventsOfType(engine.home, "command.delivered")).toHaveLength(0);
});

test("a viewer that never answers lets the hook fall through after the window, and the card stops offering Allow and Deny", async ({
  browser,
}) => {
  const page = await openCity(browser);
  const hook = raiseRequest();
  await openCard(page);
  await expect(allow(page)).toBeEnabled();

  const answer = await settled(hook.answer, (HOLD_WINDOW_SECONDS + 10) * 1000);
  expect(answer.status).toBeGreaterThanOrEqual(200);
  expect(answer.status).toBeLessThan(300);
  expect(answer.text).toBe("");
  expect(answer.elapsedMs).toBeGreaterThanOrEqual(HOLD_WINDOW_SECONDS * 1000 - 500);

  // Decision #271 D2: after fall-through the engine drops the exact input and fails a late
  // decision as expired, so the card shows Open session only. M4.07 pins two ways to get there
  // (`data-variant="open-only"`, or `data-state="expired"` with every button off), so accept
  // either; what must hold is that Allow and Deny are no longer offered.
  await expect
    .poll(
      async () => {
        const variant = await card(page).getAttribute("data-variant");
        const state = await card(page).getAttribute("data-state");
        return variant === "open-only" || state === "expired" || state === "closed";
      },
      { timeout: 15_000, message: "the card should leave its answerable state" },
    )
    .toBe(true);
  await expect(allow(page)).toHaveCount(0);
  await expect(deny(page)).toHaveCount(0);

  // The engine never recorded a decision.
  expect(eventsOfType(engine.home, "command.delivered")).toHaveLength(0);
});

test("a double click on Allow answers once", async ({ browser }) => {
  const page = await openCity(browser);
  const hook = raiseRequest();
  await openCard(page);

  await allow(page).dblclick();

  const answer = await settled(hook.answer);
  expect(answer.json).toEqual(recordedAllowBody());
  await expect(card(page)).toHaveAttribute("data-state", "sent");
  // Give a second request time to arrive, then count: exactly one command, one delivery.
  await page.waitForTimeout(1_000);
  const commands = eventsOfType(engine.home, "command.requested");
  expect(commands.filter((e) => e.payload.commandType === "permission.decide")).toHaveLength(1);
  expect(eventsOfType(engine.home, "command.delivered")).toHaveLength(1);
});
