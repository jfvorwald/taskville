import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { storedEnvelopeSchemas } from "../../../../../packages/protocol/src/index.ts";
import { eventBuilder, PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import {
  attention,
  initialState,
  projectStateHash,
  REDUCER_VERSION,
  reduce,
  snapshotResponseSchema,
} from "../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

const START = Date.parse("2026-10-30T10:00:00Z");
const TIMELINE = `live:${PROJECT}`;

function recording(offsets: number[]) {
  const emit = eventBuilder();
  return offsets.map((offset, index) => {
    const event = emit("agent.registered", `recorded-${index + 1}`);
    return storedEnvelopeSchemas["agent.registered"].parse({
      ...event,
      receivedAt: new Date(START + offset).toISOString(),
    });
  });
}

// Transport only: the real provider, controller, DataStore and reducer remain mounted.
// Mirrors timelines/routes.ts: timestamp selects greatest matching sequence; numeric at is
// an ingest sequence. State hashes and response envelopes are generated from real replay.
function engine(offsets: number[]) {
  const log = recording(offsets);
  const stateAt = (sequence: number) =>
    log.slice(0, sequence).reduce(reduce, initialState(PROJECT));
  const requests: URL[] = [];
  const pending: Array<() => void> = [];
  let defer = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    requests.push(url);
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get(SESSION_HEADER)).toBe(SECRET);
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/projects/${PROJECT}/timelines`) {
      return Response.json({
        projectId: PROJECT,
        timelines: [
          {
            id: TIMELINE,
            kind: "live",
            projectId: PROJECT,
            firstSequence: 1,
            lastSequence: log.length,
            eventCount: log.length,
            firstAt: log[0]?.receivedAt,
            lastAt: log.at(-1)?.receivedAt,
          },
        ],
      });
    }
    const resolvePosition = (raw: string) =>
      /^\d+$/.test(raw)
        ? Math.min(Number(raw), log.length)
        : (log.filter((event) => Date.parse(event.receivedAt) <= Date.parse(raw)).at(-1)
            ?.ingestSequence ?? 0);
    if (path === `/v1/timelines/${TIMELINE}/events`) {
      const cursor = url.searchParams.get("cursor");
      const decoded = cursor
        ? JSON.parse(atob(cursor.slice(4).replace(/-/g, "+").replace(/_/g, "/")))
        : null;
      if (decoded) expect(decoded[0]).toBe(TIMELINE);
      const from =
        decoded?.[1] ??
        (url.searchParams.has("from")
          ? /^\d+$/.test(url.searchParams.get("from") ?? "")
            ? Math.max(1, Number(url.searchParams.get("from")))
            : (log.find(
                (event) =>
                  Date.parse(event.receivedAt) >= Date.parse(url.searchParams.get("from") ?? ""),
              )?.ingestSequence ?? log.length + 1)
          : 1);
      const until =
        decoded?.[2] ??
        (url.searchParams.has("to")
          ? resolvePosition(url.searchParams.get("to") ?? "")
          : log.length);
      const events = log
        .filter((event) => event.ingestSequence >= from && event.ingestSequence <= until)
        .slice(0, Number(url.searchParams.get("limit") ?? 200));
      const last = events.at(-1)?.ingestSequence;
      const nextCursor =
        last !== undefined && last < until
          ? `tl1.${btoa(JSON.stringify([TIMELINE, last + 1, until]))
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "")}`
          : null;
      return Response.json({ timelineId: TIMELINE, events, nextCursor });
    }
    expect(path).toBe(`/v1/timelines/${TIMELINE}/state`);
    const at = url.searchParams.get("at");
    expect(at).not.toBeNull();
    const state = stateAt(resolvePosition(at ?? ""));
    const snapshot = snapshotResponseSchema.parse({
      projectId: PROJECT,
      cursor: state.head,
      reducerVersion: REDUCER_VERSION,
      stateHash: projectStateHash(state),
      state,
      attention: attention(
        state,
        Date.parse(log[state.head - 1]?.receivedAt ?? new Date(START).toISOString()),
      ),
      computedAt: "2026-11-01T12:00:00Z",
    });
    const response = () => Response.json({ timelineId: TIMELINE, at: state.head, ...snapshot });
    // Ignore abort deliberately, so lifecycle tests exercise publication fencing too.
    if (defer) return new Promise<Response>((resolve) => pending.push(() => resolve(response())));
    return response();
  };
  return {
    log,
    stateAt,
    requests,
    fetcher,
    pending,
    defer: () => {
      defer = true;
    },
  };
}

function Presented() {
  const history = useHistoryPresentation();
  const view = useSyncExternalStore(history.store.subscribe, history.store.getState);
  return (
    <output aria-label="Presented recording">
      {history.mode}:{view.state?.head ?? 0}:{Object.keys(view.state?.agents ?? {}).join(",")}
      {JSON.stringify(view.state?.activity ?? {})}
    </output>
  );
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

async function mount(offsets: number[]) {
  const transport = engine(offsets);
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(transport.stateAt(transport.log.length - 1));
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <HistoryControls />
        <Presented />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await page.getByRole("button", { name: "History", exact: true }).click();
  return { ...transport, view };
}

async function presented(head: number, mode = "history") {
  const text = () =>
    page.getByRole("status", { name: "Presented recording" }).element().textContent;
  await expect.poll(text).toContain(`${mode}:${head}:`);
  // Pin actual reducer content as well as cursor metadata.
  if (head) await expect.poll(text).toContain(`recorded-${head}`);
}

async function key(key: "Home" | "End") {
  (page.getByRole("slider", { name: "Timeline time" }).element() as HTMLInputElement).focus();
  await userEvent.keyboard(`{${key}}`);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function click(name: string) {
  act(() => {
    (page.getByRole("button", { name, exact: true }).element() as HTMLButtonElement).click();
  });
}

function speed(rate: number) {
  act(() => {
    const select = page
      .getByRole("combobox", { name: "Playback speed" })
      .element() as HTMLSelectElement;
    const option = [...select.options].find((option) => option.textContent === `${rate}x`);
    expect(option).toBeDefined();
    select.value = option?.value ?? "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("timeline fixture contract", () => {
  it("serves schema-valid distinct replay states and two real cursor pages", async () => {
    const transport = engine(Array.from({ length: 202 }, () => 0));
    const read = async (suffix: string) =>
      (
        await transport.fetcher(`/v1/timelines/${encodeURIComponent(TIMELINE)}/${suffix}`, {
          headers: { [SESSION_HEADER]: SECRET },
        })
      ).json();
    const first = await read("events");
    expect(first.events).toHaveLength(200);
    expect(first.events.at(-1).ingestSequence).toBe(200);
    expect(first.nextCursor).toMatch(/^tl1\./);
    const second = await read(`events?cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(second.events.map((event: { ingestSequence: number }) => event.ingestSequence)).toEqual([
      201, 202,
    ]);
    expect(second.nextCursor).toBeNull();
    const one = await read("state?at=1");
    const two = await read("state?at=2");
    const head = await read(`state?at=${encodeURIComponent(new Date(START).toISOString())}`);
    expect([one.at, two.at, head.at]).toEqual([1, 2, 202]);
    expect(new Set([one.stateHash, two.stateHash, head.stateHash]).size).toBe(3);
    expect(two.state).toEqual(transport.stateAt(2));
  });
});

describe("recorded sequence navigation through HistoryProvider and Controls", () => {
  it("Home reaches the first same-millisecond state, then all moments remain reachable", async () => {
    await mount([0, 0, 0, 0]);
    await presented(4);
    await key("Home");
    await presented(1); // Current time-only slider stays at head 4, before missing buttons.
    await expect
      .element(page.getByRole("slider", { name: "Timeline time" }))
      .toHaveAttribute("aria-valuetext", new Date(START).toLocaleString());
    await expect.element(page.getByRole("button", { name: "Previous moment" })).toBeDisabled();
    for (const head of [2, 3, 4]) {
      await page.getByRole("button", { name: "Next moment" }).click();
      await presented(head);
    }
    await expect.element(page.getByRole("button", { name: "Next moment" })).toBeDisabled();
    for (const head of [3, 2, 1]) {
      await page.getByRole("button", { name: "Previous moment" }).click();
      await presented(head);
    }
    await key("End");
    await presented(4);
  });

  it("accepts regressing receivedAt and navigates in ingest order", async () => {
    await mount([3000, 2000, 1000, 0]);
    await presented(4); // Current metadata validation rejects firstAt > lastAt.
    await key("Home");
    await presented(1);
    for (const head of [2, 3, 4]) {
      await page.getByRole("button", { name: "Next moment" }).click();
      await presented(head);
      await expect
        .element(page.getByRole("slider", { name: "Timeline time" }))
        .toHaveAttribute("aria-valuetext", new Date(START + (4 - head) * 1000).toLocaleString());
    }
    await key("Home");
    await presented(1);
    await key("End");
    await presented(4);
  });

  it("crosses a two-page event boundary in both directions", async () => {
    await mount(Array.from({ length: 202 }, () => 0));
    await presented(202);
    expect(page.getByRole("button", { name: "Previous moment" }).elements()).toHaveLength(1);
    for (const head of [201, 200, 199]) {
      await page.getByRole("button", { name: "Previous moment" }).click();
      await presented(head);
    }
    for (const head of [200, 201, 202]) {
      await page.getByRole("button", { name: "Next moment" }).click();
      await presented(head);
    }
  });
});

const PLAY_LOG = [0, 500, 5000, 30_000, 300_000, 1_200_000];
describe("visible playback controls drive recorded presentation", () => {
  it.each([1, 10, 60, 600])(
    "plays at %ix, pauses and returns to the latest live store",
    async (rate) => {
      const transport = await mount(PLAY_LOG);
      await presented(6);
      expect(page.getByRole("button", { name: "Play", exact: true }).elements()).toHaveLength(1);
      const selector = page.getByRole("combobox", { name: "Playback speed" });
      await expect.element(selector).toBeVisible();
      expect(
        [...(selector.element() as HTMLSelectElement).options].map((option) => option.textContent),
      ).toEqual(["1x", "10x", "60x", "600x"]);
      await key("Home");
      await presented(1);
      vi.useFakeTimers();
      vi.setSystemTime(START);
      speed(rate);
      click("Play");
      await advance(1000);
      // Events sit halfway inside each rate's elapsed window, independent of timer cadence.
      expect(
        page.getByRole("status", { name: "Presented recording" }).element().textContent,
      ).toContain(`history:${[1, 10, 60, 600].indexOf(rate) + 2}:`);
      click("Pause");
      const paused = page
        .getByRole("status", { name: "Presented recording" })
        .element().textContent;
      const reads = transport.requests.length;
      await advance(2000);
      expect(transport.requests).toHaveLength(reads);
      expect(page.getByRole("status", { name: "Presented recording" }).element().textContent).toBe(
        paused,
      );
      // Live advanced independently while replay was paused.
      act(() => {
        dataStore.getState().applySnapshotState(transport.stateAt(6));
      });
      click("Return live");
      await advance(2000);
      expect(
        page.getByRole("status", { name: "Presented recording" }).element().textContent,
      ).toContain("live:6:");
      expect(transport.requests).toHaveLength(reads);
    },
  );

  it("changes rate from the current position and pauses at the recorded endpoint", async () => {
    const transport = await mount(PLAY_LOG);
    await presented(6);
    expect(page.getByRole("button", { name: "Play", exact: true }).elements()).toHaveLength(1);
    await key("Home");
    await presented(1);
    vi.useFakeTimers();
    vi.setSystemTime(START);
    click("Play");
    await advance(1000);
    expect(
      page.getByRole("status", { name: "Presented recording" }).element().textContent,
    ).toContain("history:2:");
    speed(60);
    await advance(1000);
    expect(
      page.getByRole("status", { name: "Presented recording" }).element().textContent,
    ).toContain("history:4:");
    speed(600);
    await advance(5000);
    expect(
      page.getByRole("status", { name: "Presented recording" }).element().textContent,
    ).toContain("history:6:");
    expect(page.getByRole("button", { name: "Play", exact: true }).elements()).toHaveLength(1);
    const reads = transport.requests.length;
    await advance(5000);
    expect(transport.requests).toHaveLength(reads);
    for (const url of transport.requests.filter((url) => url.pathname.endsWith("/state"))) {
      const at = url.searchParams.get("at") ?? "";
      expect(/^\d+$/.test(at) ? Number(at) <= 6 : Date.parse(at) <= START + 1_200_000).toBe(true);
    }
  });

  it.each(["exit", "unmount"])(
    "%s stops scheduling and fences a late playback response",
    async (action) => {
      const transport = await mount(PLAY_LOG);
      await presented(6);
      expect(page.getByRole("button", { name: "Play", exact: true }).elements()).toHaveLength(1);
      await key("Home");
      await presented(1);
      vi.useFakeTimers();
      vi.setSystemTime(START);
      transport.defer();
      click("Play");
      await advance(1000);
      expect(transport.pending.length).toBeGreaterThan(0);
      if (action === "exit") click("Return live");
      else await transport.view.unmount();
      const reads = transport.requests.length;
      await act(async () => {
        for (const resolve of transport.pending) resolve();
      });
      await advance(5000);
      expect(transport.requests).toHaveLength(reads);
      if (action === "exit")
        expect(
          page.getByRole("status", { name: "Presented recording" }).element().textContent,
        ).toContain("live:6:");
      else
        expect(page.getByRole("status", { name: "Presented recording" }).elements()).toHaveLength(
          0,
        );
    },
  );
});
