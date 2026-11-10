import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { getSettingsStore } from "../../settings/store.ts";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, build, PROJECT, paint, seedStore } from "./liveKit.tsx";

// M10.04 (#489) item 1, red first: one shared evidence budget. An open group preview (5 members)
// plus two expanded groups (32 members per page, both body parts) ask for 10 + 64 + 64 = 138
// bodies, more than the 128-body cache. The preview is requested first, so it is evicted first
// and was never retried. Contract: every body an open preview or expanded group shows is
// eventually loaded. Either size requests against one budget that reserves room for open
// previews, or retry requested bodies the cache evicted. Smaller pages are allowed.

afterEach(() => {
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

const read = (group: string, n: number) => ({
  id: `budget-${group}-${n}`,
  tool: "Read",
  input: { file_path: `/synthetic/budget/${group}-${n}.ts` },
  output: { file: `body ${group} ${n}` },
});
const grep = (n: number) => ({
  id: `budget-grep-${n}`,
  tool: "Grep",
  input: { pattern: `needle-${n}` },
  output: { filenames: [`/synthetic/budget/hit-${n}.ts`] },
});

it("loads the open preview's bodies although two expanded groups fill the cache", async () => {
  // Read group "pre" (preview only), a Search group, then another Read group: three separate runs.
  const { calls, evidence } = build([
    ...Array.from({ length: 6 }, (_, n) => read("pre", n)),
    ...Array.from({ length: 40 }, (_, n) => grep(n)),
    ...Array.from({ length: 40 }, (_, n) => read("late", n)),
  ]);
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      return Response.json(evidence[id]);
    }
    if (!url.pathname.endsWith("/feed")) throw new Error("Unexpected synthetic route");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          calls.forEach((data, index) => {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${index + 1}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const view = await render(
    <div data-testid="agent-panel-tab-slot" style={{ height: 6000, width: 400, overflowY: "auto" }}>
      <SessionProvider value="synthetic-m1004-budget">
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  try {
    const groups = page.getByTestId("agent-panel-tab-slot").getByRole("article");
    await expect.poll(() => groups.elements().length).toBe(3);
    const [pre, search, late] = [0, 1, 2].map((n) => groups.nth(n));
    await expect.element(pre).toMatchTextContent("Read 6 files");
    await expect.element(search).toMatchTextContent("Searched 40 times");
    await expect.element(late).toMatchTextContent("Read 40 files");
    const open = async (group: typeof pre) => {
      const toggle = group.getByRole("button", { name: /^details\b/i });
      if (toggle.element().getAttribute("aria-expanded") === "false") await toggle.click();
    };
    // Open the small group's preview first, so its bodies are the oldest, then expand the big ones.
    await open(pre);
    await expect
      .poll(() => pre.element().textContent ?? "", { timeout: 5000 })
      .toContain("/synthetic/budget/pre-4.ts");
    for (const group of [search, late]) {
      await open(group);
      await group.getByRole("button", { name: /^Expand (patterns|paths)$/ }).click();
    }
    await paint();
    // Visible outcome 1: after the big groups load, the preview still names its first five
    // members from loaded bodies (it must not lose them to eviction and stay unretried).
    await expect
      .poll(() => pre.element().textContent ?? "", { timeout: 5000 })
      .toContain("/synthetic/budget/pre-4.ts");
    for (let n = 0; n < 5; n++)
      expect(pre.element().textContent).toContain(`/synthetic/budget/pre-${n}.ts`);
    // Visible outcome 2: the expanded groups show a body for every listed row, none left unloaded.
    for (const group of [search, late]) {
      await expect
        .poll(() => group.getByRole("listitem").elements().length, { timeout: 5000 })
        .toBeGreaterThan(0);
      await expect
        .poll(
          () =>
            group
              .getByRole("listitem")
              .elements()
              .every((row) => !(row.textContent ?? "").includes("details not loaded")),
          { timeout: 5000 },
        )
        .toBe(true);
    }
  } finally {
    await view.unmount();
  }
});

// Finding 1 of roborev job 7699: under privacy an open, unexpanded group requests no preview
// bodies, so it must reserve no budget. Seven open groups must not shrink the expanded group's
// 32-row page (it showed 29 paths, "and 11 more", instead of 32, "and 8 more").
it("under privacy open previews reserve nothing, so an expanded group shows 32 paths", async () => {
  const specs = [
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((g) =>
      Array.from({ length: 6 }, (_, n) =>
        g % 2 === 0
          ? { ...grep(g * 10 + n), filePaths: [`/synthetic/budget/s${g}-${n}.ts`] }
          : { ...read(`r${g}`, n), filePaths: [`/synthetic/budget/r${g}-${n}.ts`] },
      ),
    ),
    ...Array.from({ length: 40 }, (_, n) => ({
      ...read("big", n),
      filePaths: [`/synthetic/budget/big-${n}.ts`],
    })),
  ];
  const { calls, evidence } = build(specs);
  selectProject(PROJECT);
  getSettingsStore().set("privacyMode", false);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      return Response.json(evidence[id]);
    }
    if (!url.pathname.endsWith("/feed")) throw new Error("Unexpected synthetic route");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          calls.forEach((data, index) => {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${index + 1}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const view = await render(
    <div data-testid="agent-panel-tab-slot" style={{ height: 8000, width: 400, overflowY: "auto" }}>
      <SessionProvider value="synthetic-m1004-privacy-budget">
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  try {
    const groups = page.getByTestId("agent-panel-tab-slot").getByRole("article");
    await expect.poll(() => groups.elements().length).toBe(8);
    for (let n = 0; n < 8; n++) {
      const toggle = groups.nth(n).getByRole("button", { name: /^details\b/i });
      if (toggle.element().getAttribute("aria-expanded") === "false") await toggle.click();
    }
    await groups
      .nth(7)
      .getByRole("button", { name: /^Expand paths$/ })
      .click();
    await paint();
    getSettingsStore().set("privacyMode", true);
    await paint();
    await expect
      .poll(() => groups.nth(7).element().textContent ?? "", { timeout: 5000 })
      .toContain("Code hidden by the privacy setting");
    const text = groups.nth(7).element().textContent ?? "";
    expect(text).toContain("/synthetic/budget/big-31.ts");
    expect(text).not.toContain("/synthetic/budget/big-32.ts");
    expect(text).toContain("and 8 more");
  } finally {
    getSettingsStore().set("privacyMode", false);
    await view.unmount();
  }
});

// M10.05 (#523), red first: 14 open, unexpanded five-call previews ask for 14 x 5 x 2 = 140
// bodies, over the 128-body cache, and no expanded group exists to shrink. Early preview bodies
// are evicted and never retried, so a preview silently loses its names. Contract: every open
// preview lists all five of its names, or shows a visible "not loaded" marker; never a silently
// missing or partial list. Marked previews must load once demand falls (other previews collapse).
// Either fix passes: request fewer body parts, or cap previews with a recoverable marker.
it("never silently drops preview names when 14 open previews exceed the evidence cache", async () => {
  const GROUPS = 14;
  const namesOf = (g: number) =>
    Array.from({ length: 5 }, (_, n) =>
      g % 2 === 0 ? `/synthetic/budget/p${g}-${n}.ts` : `needle-p${g}-${n}`,
    );
  const specs = Array.from({ length: GROUPS }, (_, g) =>
    Array.from({ length: 5 }, (_, n) =>
      g % 2 === 0
        ? read(`p${g}`, n)
        : {
            id: `budget-p${g}-${n}`,
            tool: "Grep",
            input: { pattern: `needle-p${g}-${n}` },
            output: { filenames: [`/synthetic/budget/hit-p${g}-${n}.ts`] },
          },
    ),
  ).flat();
  const { calls, evidence } = build(specs);
  selectProject(PROJECT);
  // Hold every body response until all 14 previews are open, then release them as one burst.
  // Bodies then land before any render can re-touch the ones it shows, so the cache's oldest
  // 12 (the first preview's) are evicted for real, as they are when many responses arrive at once.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      await gate;
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      return Response.json(evidence[id]);
    }
    if (!url.pathname.endsWith("/feed")) throw new Error("Unexpected synthetic route");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          calls.forEach((data, index) => {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${index + 1}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const view = await render(
    <div
      data-testid="agent-panel-tab-slot"
      style={{ height: 16000, width: 400, overflowY: "auto" }}
    >
      <SessionProvider value="synthetic-m1005-many-previews">
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  try {
    const groups = page.getByTestId("agent-panel-tab-slot").getByRole("article");
    await expect.poll(() => groups.elements().length).toBe(GROUPS);
    for (let g = 0; g < GROUPS; g++) {
      const toggle = groups.nth(g).getByRole("button", { name: /^details\b/i });
      if (toggle.element().getAttribute("aria-expanded") === "false") await toggle.click();
    }
    release();
    // "complete" = every name shown; "marked" = a visible not-loaded state; else it is silent.
    const state = (g: number, closed: ReadonlySet<number>) => {
      if (closed.has(g)) return "closed";
      const text = groups.nth(g).element().textContent ?? "";
      if (namesOf(g).every((name) => text.includes(name))) return "complete";
      return /not loaded/i.test(text) ? "marked" : "silent";
    };
    const closed = new Set<number>();
    const states = () => Array.from({ length: GROUPS }, (_, g) => state(g, closed));
    await paint();
    // No preview may stay silently short of its names (loading settles into complete or marked).
    await expect
      .poll(() => states().filter((s) => s === "silent").length, { timeout: 8000 })
      .toBe(0);
    await paint();
    expect(states().filter((s) => s === "silent")).toEqual([]);
    // Recovery: collapse loaded previews to free demand; every marked preview must then load.
    const loaded = states().flatMap((s, g) => (s === "complete" ? [g] : []));
    for (const g of loaded.slice(0, 8)) {
      await groups
        .nth(g)
        .getByRole("button", { name: /^details\b/i })
        .click();
      closed.add(g);
    }
    await paint();
    await expect
      .poll(() => states().filter((s) => s !== "complete" && s !== "closed"), { timeout: 8000 })
      .toEqual([]);
  } finally {
    await view.unmount();
  }
});

// M10.05 (#523) roborev 7738: previews now fetch only the input part (5 bodies each), so 14
// previews (70 bodies) never reach the 128-body cap. 30 open five-call previews demand 150
// distinct input bodies, so the cap path (grant stops at 128, "details not loaded" marker) runs.
it("marks previews past the 128-body cap, then loads them once earlier previews collapse", async () => {
  const GROUPS = 30;
  const namesOf = (g: number) =>
    Array.from({ length: 5 }, (_, n) =>
      g % 2 === 0 ? `/synthetic/budget/q${g}-${n}.ts` : `needle-q${g}-${n}`,
    );
  const specs = Array.from({ length: GROUPS }, (_, g) =>
    Array.from({ length: 5 }, (_, n) =>
      g % 2 === 0
        ? read(`q${g}`, n)
        : {
            id: `budget-q${g}-${n}`,
            tool: "Grep",
            input: { pattern: `needle-q${g}-${n}` },
            output: { filenames: [`/synthetic/budget/hit-q${g}-${n}.ts`] },
          },
    ),
  ).flat();
  const { calls, evidence } = build(specs);
  selectProject(PROJECT);
  const requested = new Set<string>();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      requested.add(id);
      await gate;
      return Response.json(evidence[id]);
    }
    if (!url.pathname.endsWith("/feed")) throw new Error("Unexpected synthetic route");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          calls.forEach((data, index) => {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${index + 1}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          });
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  // The tab slot is far taller than 30 open previews, so the virtualized list mounts them all;
  // the poll below on 30 mounted articles proves it.
  const view = await render(
    <div
      data-testid="agent-panel-tab-slot"
      style={{ height: 40000, width: 400, overflowY: "auto" }}
    >
      <SessionProvider value="synthetic-m1005-cap-previews">
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  try {
    const groups = page.getByTestId("agent-panel-tab-slot").getByRole("article");
    await expect.poll(() => groups.elements().length).toBe(GROUPS);
    for (let g = 0; g < GROUPS; g++) {
      const toggle = groups.nth(g).getByRole("button", { name: /^details\b/i });
      if (toggle.element().getAttribute("aria-expanded") === "false") await toggle.click();
    }
    // Every preview is open and mounted: 30 x 5 = 150 input bodies are wanted, over the cap.
    expect(groups.elements().length).toBe(GROUPS);
    release();
    const state = (g: number, closed: ReadonlySet<number>) => {
      if (closed.has(g)) return "closed";
      const text = groups.nth(g).element().textContent ?? "";
      if (namesOf(g).every((name) => text.includes(name))) return "complete";
      return /not loaded/i.test(text) ? "marked" : "silent";
    };
    const closed = new Set<number>();
    const states = () => Array.from({ length: GROUPS }, (_, g) => state(g, closed));
    await paint();
    await expect
      .poll(() => states().filter((s) => s === "silent").length, { timeout: 8000 })
      .toBe(0);
    await paint();
    expect(states().filter((s) => s === "silent")).toEqual([]);
    // The cap was reached: some preview is marked, and no more than 128 distinct bodies were asked for.
    expect(states().filter((s) => s === "marked").length).toBeGreaterThan(0);
    expect(requested.size).toBeLessThanOrEqual(128);
    expect(requested.size).toBeGreaterThan(120);
    // Recovery: collapse earlier loaded previews until demand (open x 5) is under 128.
    const loaded = states().flatMap((s, g) => (s === "complete" ? [g] : []));
    const toClose = Math.ceil((GROUPS * 5 - 127) / 5);
    for (const g of loaded.slice(0, toClose)) {
      await groups
        .nth(g)
        .getByRole("button", { name: /^details\b/i })
        .click();
      closed.add(g);
    }
    await paint();
    await expect
      .poll(() => states().filter((s) => s !== "complete" && s !== "closed"), { timeout: 8000 })
      .toEqual([]);
    for (let g = 0; g < GROUPS; g++)
      if (!closed.has(g)) expect(groups.nth(g).element().textContent).not.toMatch(/not loaded/i);
  } finally {
    await view.unmount();
  }
});
