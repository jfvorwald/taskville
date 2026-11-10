import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import { WINDOW_EVENTS } from "./archive-timelines.ts";
import { COUNT, ID, occurred, scaleEngine } from "./scale-fixture.ts";

// M8.15 (issue 501), archive window edge cases in a 200,000 event archive:
// 1. a superseded far seek never publishes its candidate window: strip, slider, chip and city
//    agree on the position the city is really at;
// 2. a bucketed marker that shows a higher-priority kind seeks to that priority marker's event;
// 3. a subagent registered before the loaded window and finished inside it still has a crew bar
//    with the right start.

function Composition() {
  const { store, mode } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <>
      <output aria-label="Presented head">{`${mode}:${view.state?.head ?? 0}`}</output>
      <HistoryControls />
    </>
  );
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

const head = () => page.getByRole("status", { name: "Presented head" }).element().textContent;
const slider = () =>
  page.getByRole("slider", { name: "Timeline time" }).element() as HTMLInputElement;
const chip = () => page.getByText(/^HISTORY\s*·/).element().textContent ?? "";
const markerLabels = () =>
  [...document.querySelectorAll("[data-marker]")].map(
    (node) => node.getAttribute("aria-label") ?? "",
  );
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

function setSlider(value: number) {
  act(() => {
    const input = slider();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

type Rewrite = (sequence: number, event: Record<string, unknown>) => Record<string, unknown>;

/** The scale archive, with chosen events rewritten and state reads for chosen positions held or failed. */
async function open(options: { rewrite?: Rewrite; holdState?: number; failState?: number } = {}) {
  const base = scaleEngine();
  const seen = { held: false };
  const control = { failEvents: false };
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/timelines/${ID}/state`) {
      const at = Number(url.searchParams.get("at"));
      if (at === options.failState) return new Response("boom", { status: 500 });
      if (at === options.holdState) {
        seen.held = true;
        await gate;
      }
    }
    if (path === `/v1/timelines/${ID}/events` && control.failEvents)
      return new Response("boom", { status: 500 });
    const response = await base.fetcher(input, init);
    if (path !== `/v1/timelines/${ID}/events` || !options.rewrite) return response;
    const body = await response.json();
    const rewrite = options.rewrite;
    body.events = body.events.map((event: Record<string, unknown>) =>
      rewrite(event.ingestSequence as number, event),
    );
    return Response.json(body);
  };
  vi.stubGlobal("fetch", fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Composition />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(head, { timeout: 30_000 }).toBe(`history:${COUNT}`);
  return { seen, release, control };
}

describe("a superseded far seek", () => {
  it("never publishes its candidate window after a later seek into that window fails", async () => {
    const { seen, release } = await open({ holdState: 1, failState: 2 });
    const stripBefore = markerLabels();
    expect(stripBefore.length).toBeGreaterThan(0);
    const chipBefore = chip();

    // Seek A moves toward the oldest window; its state read is held.
    setSlider(1);
    await expect.poll(() => seen.held, { timeout: 30_000 }).toBe(true);
    // Seek B targets the same unloaded window, and its state read fails.
    setSlider(2);
    await expect.element(page.getByText("Could not load recorded state.")).toBeVisible();
    // A's response arrives late; it was superseded and must not publish anything.
    release();
    await settle();

    // The city never moved, so strip, slider and chip may not claim it did.
    expect(head()).toBe(`history:${COUNT}`);
    expect(slider().value).toBe(String(COUNT));
    expect(chip()).toBe(chipBefore);
    expect(markerLabels()).toEqual(stripBefore);
  }, 120_000);
});

describe("a bucketed strip marker", () => {
  it("seeks to the displayed priority marker, not the first marker of the bucket", async () => {
    const NEEDS = COUNT - WINDOW_EVENTS + 10;
    await open({
      rewrite: (sequence, event) =>
        sequence === NEEDS
          ? {
              ...event,
              type: "request.opened",
              agentId: "agent-asker",
              payload: {
                requestId: "bucket-request",
                kind: "permission",
                toolName: "Read",
                inputPreview: "preview",
              },
            }
          : event,
    });
    // The window holds 5,000 commits in 200 buckets; the first bucket carries the request.
    const bucket = document.querySelector('[data-marker="Needs you"]') as HTMLButtonElement | null;
    expect(bucket).not.toBeNull();
    act(() => bucket?.click());
    await expect.poll(head, { timeout: 30_000 }).toBe(`history:${NEEDS}`);
  }, 120_000);
});

describe("crew runs across windows", () => {
  it("keeps a subagent registered before the loaded window, with its true start", async () => {
    const REGISTERED = 10;
    const FINISHED = COUNT - 100;
    const PARENT = "claude-code:parent-session";
    const CHILD = `${PARENT}:worker`;
    await open({
      rewrite: (sequence, event) =>
        sequence === REGISTERED
          ? {
              ...event,
              type: "agent.registered",
              agentId: CHILD,
              payload: {
                sourceAgentId: "worker",
                displayName: "Late worker",
                role: "general-purpose",
                kind: "subagent",
                parentAgentId: PARENT,
              },
            }
          : sequence === FINISHED
            ? { ...event, type: "agent.finished", agentId: CHILD, payload: { summary: "done" } }
            : event,
    });
    // Registration is outside the newest window; the finish is inside it.
    const bar = page.getByRole("img", { name: /Late worker/ });
    await expect.element(bar).toBeVisible();
    const label = (bar.element() as HTMLElement).getAttribute("aria-label") ?? "";
    expect(label).toContain(new Date(occurred(REGISTERED)).toLocaleString());
  }, 120_000);
});

// M8.15 review round (roborev 7640).
const PARENT = "claude-code:parent-session";
const child = (name: string) => `${PARENT}:${name}`;
const registration = (name: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  type: "agent.registered",
  agentId: child(name),
  payload: {
    sourceAgentId: name,
    displayName,
    role: "general-purpose",
    kind: "subagent",
    parentAgentId: PARENT,
    ...extra,
  },
});
const finish = (name: string) => ({
  type: "agent.finished",
  agentId: child(name),
  payload: { summary: "done" },
});
const rewriteAt =
  (specs: Record<number, Record<string, unknown>>): Rewrite =>
  (sequence, event) =>
    specs[sequence] ? { ...event, ...specs[sequence] } : event;
const bar = (name: RegExp) => page.getByRole("img", { name });
const barLabel = (name: RegExp) =>
  (bar(name).element() as HTMLElement).getAttribute("aria-label") ?? "";
const agentOptions = () =>
  [...document.querySelectorAll("#history-agent option")].map((node) => node.textContent ?? "");

describe("a superseded seek whose successor fails to load events", () => {
  it("does not let the first seek's state read move the city", async () => {
    const { seen, release, control } = await open({ holdState: 1 });
    const stripBefore = markerLabels();
    const chipBefore = chip();

    setSlider(1);
    await expect.poll(() => seen.held, { timeout: 30_000 }).toBe(true);
    // Seek B starts, and loading its event window fails.
    control.failEvents = true;
    setSlider(2);
    await expect.element(page.getByText("Could not load recorded state.")).toBeVisible();
    // A's state read arrives after B began; B invalidated it.
    release();
    await settle();

    expect(head()).toBe(`history:${COUNT}`);
    expect(slider().value).toBe(String(COUNT));
    expect(chip()).toBe(chipBefore);
    expect(markerLabels()).toEqual(stripBefore);
  }, 120_000);
});

describe("crew runs resolved from before the window", () => {
  it("closes every child whose finish is recorded before or inside the window", async () => {
    // Both register in the first chunk; A finishes in a later chunk still before the window.
    await open({
      rewrite: rewriteAt({
        10: registration("a", "Worker A"),
        20: registration("b", "Worker B"),
        7000: finish("a"),
        [COUNT - 100]: finish("b"),
      }),
    });
    await expect.element(bar(/Worker B/)).toBeVisible();
    // A run fully before the window is still drawn, on the whole archive's scale, finished.
    await expect.element(bar(/Worker A/)).toBeVisible();
    await expect
      .poll(() => barLabel(/Worker A/))
      .toContain(new Date(occurred(10)).toLocaleString());
    await expect.poll(() => barLabel(/Worker A/)).toContain(`ran ${(7_000 - 10) * 60}s`);
    await expect
      .poll(() => barLabel(/Worker B/))
      .toContain(new Date(occurred(20)).toLocaleString());
    await expect.poll(() => barLabel(/Worker B/)).toContain(`ran ${(COUNT - 100 - 20) * 60}s`);
  }, 120_000);

  it("ignores a heuristic registration in the window and keeps the recorded start", async () => {
    await open({
      rewrite: rewriteAt({
        10: registration("h", "Recorded worker"),
        [COUNT - 200]: registration("h", "Guessed worker", { heuristic: true }),
        [COUNT - 100]: finish("h"),
      }),
    });
    await expect.element(bar(/Recorded worker/)).toBeVisible();
    await expect
      .poll(() => barLabel(/Recorded worker/))
      .toContain(new Date(occurred(10)).toLocaleString());
    await expect
      .poll(() => barLabel(/Recorded worker/))
      .toContain(`ran ${(COUNT - 100 - 10) * 60}s`);
  }, 120_000);

  it("names the agent in the selector once the scan finds its registration", async () => {
    await open({
      rewrite: rewriteAt({ 10: registration("n", "Scanned worker"), [COUNT - 100]: finish("n") }),
    });
    await expect.element(bar(/Scanned worker/)).toBeVisible();
    // No further window publish happens; the selector must already carry the name.
    await expect.poll(agentOptions).toContain("Scanned worker");
    expect(agentOptions()).not.toContain(child("n"));
  }, 120_000);
});

// M8.16 (issue 509): out-of-order source events. A finish recorded before the agent's first
// recorded registration, with the finish before the loaded window and the registration inside it.
const barState = (name: RegExp) =>
  (bar(name).element() as HTMLElement).getAttribute("data-state") ?? "";

describe("a finish recorded before its registration, across windows", () => {
  it("shows the agent as finished when the finish is before the window and the registration inside it", async () => {
    await open({
      rewrite: rewriteAt({
        10: finish("early"),
        [COUNT - 100]: registration("early", "Early finisher"),
      }),
    });
    await expect.element(bar(/Early finisher/)).toBeVisible();
    // The bar may only be settled once the backward scan has looked for the earlier finish.
    await expect.poll(() => barState(/Early finisher/), { timeout: 30_000 }).toBe("finished");
    expect(barLabel(/Early finisher/)).not.toContain("running");
  }, 120_000);

  it("control: an agent registered in the window with no finish anywhere stays running", async () => {
    await open({
      rewrite: rewriteAt({ [COUNT - 100]: registration("busy", "Busy worker") }),
    });
    await expect.element(bar(/Busy worker/)).toBeVisible();
    await settle(1500);
    expect(barState(/Busy worker/)).toBe("running");
    expect(barLabel(/Busy worker/)).toContain("running");
  }, 120_000);
});
