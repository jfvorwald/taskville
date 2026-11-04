import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { getSettingsStore } from "../../settings/store.ts";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, bodyOf, PROJECT, paint, seedStore } from "./liveKit.tsx";

// M5.24 red round 2 (roborev 6674, LiveTab.tsx:575): through the connected tab, under Hide code, a
// visible collapsed Grep or Glob group shows hit filenames that exist only in output evidence, so
// the tab must load the output part of calls in visible privacy search groups, and only that, at
// most 32 (the cap) per group. Collapsed groups request no evidence today.

const CAP = 32;
let evidence: Record<string, EvidenceResponse>;
let hits: string[];

const hitName = (call: number, n = 0) =>
  `/r/conn/hit-${String(call).padStart(3, "0")}-${n}-file.ts`;

/** A search call with no recorded filePaths: hits live only in the stored output body. */
function search(tool: "Grep" | "Glob", n: number, hitCount = 1): ToolCallFrame {
  const id = `cs-${tool}-${n}`;
  const input = bodyOf(id, "input", JSON.stringify({ pattern: "CONN_PATTERN_SENTINEL" }));
  const output = bodyOf(
    id,
    "output",
    JSON.stringify({
      filenames: Array.from({ length: hitCount }, (_, i) => hitName(n, i)),
      content: "CONN_LINE_SENTINEL matched",
    }),
  );
  evidence[input.id] = input;
  evidence[output.id] = output;
  return {
    toolCallId: id,
    agentId: AGENT,
    toolName: tool,
    phase: "succeeded",
    filePaths: [],
    evidence: {
      input: { id: input.id, status: "stored" },
      output: { id: output.id, status: "stored" },
    },
  };
}

function read(n: number): ToolCallFrame {
  const id = `cs-read-${n}`;
  const input = bodyOf(id, "input", JSON.stringify({ file_path: `/r/conn/read-${n}.ts` }));
  evidence[input.id] = input;
  return {
    toolCallId: id,
    agentId: AGENT,
    toolName: "Read",
    phase: "succeeded",
    filePaths: [`/r/conn/read-${n}.ts`],
    evidence: { input: { id: input.id, status: "stored" }, output: null },
  };
}

function serve(calls: ToolCallFrame[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    if (/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname)) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            calls.forEach((c, i) => {
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${i + 1}\nevent: toolcall\ndata: ${JSON.stringify(c)}\n\n`,
                ),
              );
            });
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      hits.push(id);
      const body = evidence[id];
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  });
}

const slot = () => page.getByTestId("agent-panel-tab-slot");
const text = () => slot().element().textContent ?? "";

async function mount(calls: ToolCallFrame[], privacy: boolean, height = 460) {
  evidence = evidence ?? {};
  getSettingsStore().set("privacyMode", privacy);
  serve(calls);
  await render(
    <SessionProvider value="connected-privacy-search-session">
      <div data-testid="agent-panel-tab-slot" style={{ height, width: 400, overflowY: "auto" }}>
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </div>
    </SessionProvider>,
  );
  await expect.poll(() => text(), { timeout: 4000 }).toMatch(/Searched \d+ times|Read \d+ files/);
}

beforeEach(() => {
  evidence = {};
  hits = [];
  selectProject(PROJECT);
});
afterEach(() => {
  vi.unstubAllGlobals();
  getSettingsStore().set("privacyMode", false);
  selectProject(DEFAULT_PROJECT_ID);
});

describe.each(["Grep", "Glob"] as const)("connected privacy %s group", (tool) => {
  it("shows hit filenames found only in output evidence, no pattern, no line text", async () => {
    await mount([search(tool, 1), search(tool, 2)], true);
    await expect.poll(() => text(), { timeout: 4000 }).toContain("hit-001-0-file.ts");
    expect(text()).toContain("hit-002-0-file.ts");
    for (const out of [text(), slot().element().innerHTML]) {
      expect(out).not.toContain("CONN_PATTERN_SENTINEL");
      expect(out).not.toContain("CONN_LINE_SENTINEL");
    }
    // Only the output parts were fetched.
    expect(hits.length).toBeGreaterThan(0);
    for (const id of hits) expect(id).toMatch(/:output$/);
  });

  it("keeps evidence fetches bounded and counts unloaded searches as searches", async () => {
    await mount(
      Array.from({ length: 80 }, (_, i) => search(tool, i + 1)),
      true,
    );
    // The first 32 calls load: 32 known names, none omitted. The other 48 are not loaded.
    await expect.poll(() => text(), { timeout: 4000 }).toContain("hit-032-0-file.ts");
    await new Promise((r) => setTimeout(r, 400));
    expect(new Set(hits).size).toBeLessThanOrEqual(CAP);
    for (const id of hits) expect(id).toMatch(/:output$/);
    expect(text()).not.toContain("hit-033-0-file.ts");
    expect(text()).not.toContain("hit-080-0-file.ts");
    // The known-omitted filename count is exact (zero here), so no "and N more" appears.
    expect(text()).not.toMatch(/and \d+ more/);
    // The unknown results are reported as a count of searches, which is known.
    expect(text()).toContain("results of 48 more searches not loaded");
    // No text claims a filename count for them.
    expect(text()).not.toMatch(/48 more (files?|filenames?|names?|paths?|hits?|results?)\b/);
    expect(text()).not.toMatch(/\b48\b[^.]*\b(files|filenames|names|paths|hits)\b/);
  });

  it("states an exact 'and N more' when loaded hits exceed the cap", async () => {
    // 5 calls x 10 distinct names = 50 known names; 32 are shown, so exactly 18 are omitted.
    await mount(
      Array.from({ length: 5 }, (_, i) => search(tool, i + 1, 10)),
      true,
    );
    await expect.poll(() => text(), { timeout: 4000 }).toContain("and 18 more");
    expect(text()).not.toContain("hit-005-9-file.ts");
    expect(text()).not.toMatch(/searches not loaded/);
    expect(new Set(hits).size).toBe(5);
    for (const id of hits) expect(id).toMatch(/:output$/);
  });

  it("fetches nothing for a collapsed group with Hide code off (baseline)", async () => {
    await mount([search(tool, 1), search(tool, 2)], false);
    await new Promise((r) => setTimeout(r, 400));
    expect(hits).toEqual([]);
  });
});

describe("connected privacy Read group", () => {
  it("shows recorded names and fetches no evidence", async () => {
    await mount([read(1), read(2)], true);
    expect(text()).toContain("read-1.ts");
    expect(text()).toContain("read-2.ts");
    await new Promise((r) => setTimeout(r, 400));
    expect(hits).toEqual([]);
  });
});

// M5.24 red round 4 (roborev 6691): several mounted collapsed privacy search groups share one
// output budget that fits the 128-body evidence cache, so no group's names silently vanish.

const CACHE = 128;
const GROUPS = 5;
const PER_GROUP = 32;

/** A standalone Bash call with stored input and output bodies: it takes cache space too. */
function bash(n: number): ToolCallFrame {
  const id = `cs-bash-${n}`;
  const input = bodyOf(id, "input", JSON.stringify({ command: "echo hi" }));
  const output = bodyOf(id, "output", JSON.stringify({ stdout: "hi", stderr: "" }));
  evidence[input.id] = input;
  evidence[output.id] = output;
  return {
    toolCallId: id,
    agentId: AGENT,
    toolName: "Bash",
    phase: "succeeded",
    filePaths: [],
    evidence: {
      input: { id: input.id, status: "stored" },
      output: { id: output.id, status: "stored" },
    },
  };
}

/** A Write breaks one search run from the next; it carries no evidence. */
const divider = (n: number): ToolCallFrame => ({
  toolCallId: `cs-write-${n}`,
  agentId: AGENT,
  toolName: "Write",
  phase: "succeeded",
  filePaths: [`/r/conn/divider-${n}.ts`],
  evidence: { input: null, output: null },
});

function manyGroups(tool: "Grep" | "Glob") {
  const calls: ToolCallFrame[] = [bash(1), bash(2), bash(3)];
  for (let g = 0; g < GROUPS; g++) {
    for (let i = 0; i < PER_GROUP; i++) calls.push(search(tool, g * PER_GROUP + i + 1));
    calls.push(divider(g));
  }
  return calls;
}

const searchOutputs = () => new Set(hits.filter((id) => /^cs-(Grep|Glob)-\d+:output$/.test(id)));
const standalone = () => new Set(hits.filter((id) => id.startsWith("cs-bash-")));

/** Per group card: loaded names shown plus searches reported as not loaded. */
function accounted(): number[] {
  const root = slot().element();
  return [...root.querySelectorAll("article")]
    .filter((a) => /Searched \d+ times/.test(a.textContent ?? ""))
    .map((a) => {
      const t = a.textContent ?? "";
      const shown = t.match(/hit-\d{3}-0-file\.ts/g)?.length ?? 0;
      const unloaded = Number(t.match(/results of (\d+) more searches? not loaded/)?.[1] ?? 0);
      return shown + unloaded;
    });
}

describe.each(["Grep", "Glob"] as const)("connected privacy %s budget across groups", (tool) => {
  it("keeps one settled window within the cache and fetches nothing more", async () => {
    await mount(manyGroups(tool), true);
    // The mount shows the top first and then follows the tail, so the fetches over the whole mount
    // are the union of several windows. Measure only the settled tail window.
    await expect.poll(() => text(), { timeout: 5000 }).toContain("divider-4.ts");
    let seen = -1;
    await expect
      .poll(
        async () => {
          const stable = hits.length === seen;
          seen = hits.length;
          await new Promise((r) => setTimeout(r, 500));
          return stable;
        },
        { timeout: 8000 },
      )
      .toBe(true);
    const root = slot().element();
    const loadedOutputs = root.textContent?.match(/hit-\d{3}-0-file\.ts/g)?.length ?? 0;
    const standaloneBodies =
      2 * [...root.querySelectorAll("article h3")].filter((h) => h.textContent === "Bash").length;
    // (a) The outputs loaded for the mounted groups plus the standalone bodies in this window fit.
    expect(loadedOutputs).toBeGreaterThan(0);
    expect(loadedOutputs + standaloneBodies).toBeLessThanOrEqual(CACHE);
    // (b) Nothing new is fetched while the window stays put.
    const settled = hits.length;
    await new Promise((r) => setTimeout(r, 1000));
    expect(hits.length).toBe(settled);
  });

  it("accounts for every search in every visible group, names or not-loaded count", async () => {
    await mount(manyGroups(tool), true, 4000);
    // A tall slot mounts all five groups; each must be fully accounted for.
    const full = () => {
      const all = accounted();
      return all.length === GROUPS && all.every((n) => n === PER_GROUP);
    };
    await expect.poll(full, { timeout: 5000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(full(), JSON.stringify(accounted())).toBe(true);
    expect(text()).not.toMatch(/\b1 more searches\b/);
  });

  it("reads 'results of 1 more search not loaded' for one call past the cap", async () => {
    await mount(
      Array.from({ length: PER_GROUP + 1 }, (_, i) => search(tool, i + 1)),
      true,
    );
    await expect.poll(() => text(), { timeout: 4000 }).toContain("hit-032-0-file.ts");
    expect(text()).toContain("results of 1 more search not loaded");
    expect(text()).not.toContain("1 more searches");
  });

  it("counts a call whose output failed to load as not loaded", async () => {
    const calls = [search(tool, 1), search(tool, 2), search(tool, 3)];
    delete evidence[`${calls[1].toolCallId}:output`];
    await mount(calls, true);
    await expect.poll(() => text(), { timeout: 4000 }).toContain("hit-003-0-file.ts");
    await new Promise((r) => setTimeout(r, 400));
    expect(text()).toContain("hit-001-0-file.ts");
    expect(text()).toContain("results of 1 more search not loaded");
    expect(text()).not.toContain("1 more searches");
  });
});

// M5.24 red round 5 (confirming review of green round 4): the budget is per visible window, not a
// lifetime ledger for the stream. A live tail keeps loading, evicted bodies are fetched again when
// their call is visible again, and a static view never refetches.

interface Live {
  push: (call: ToolCallFrame) => void;
  fetches: Map<string, number>;
}

/** A stream the test feeds one frame at a time, so a tail-following view can scroll through it. */
function serveLive(delay: (id: string, nth: number) => number = () => 0): Live {
  const live: Live = { push: () => {}, fetches: new Map() };
  let next = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    if (/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname)) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            live.push = (call) => {
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${++next}\nevent: toolcall\ndata: ${JSON.stringify(call)}\n\n`,
                ),
              );
            };
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      const nth = (live.fetches.get(id) ?? 0) + 1;
      live.fetches.set(id, nth);
      hits.push(id);
      const wait = delay(id, nth);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const body = evidence[id];
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  });
  return live;
}

async function mountLive(live: Live) {
  getSettingsStore().set("privacyMode", true);
  await render(
    <SessionProvider value="connected-privacy-window-session">
      <div
        data-testid="agent-panel-tab-slot"
        style={{ height: 460, width: 400, overflowY: "auto" }}
      >
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </div>
    </SessionProvider>,
  );
  await expect.poll(() => live.push.toString().includes("enqueue")).toBe(true);
}

/** The real scrolling ancestor of the cards: the slot, or the page when the slot does not scroll. */
function scroller(): HTMLElement {
  let node = slot().element().querySelector("article")?.parentElement;
  while (node) {
    if (
      /(auto|scroll)/.test(getComputedStyle(node).overflowY) &&
      node.scrollHeight > node.clientHeight + 20
    )
      return node;
    node = node.parentElement;
  }
  return document.scrollingElement as HTMLElement;
}

const pace = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(["Grep", "Glob"] as const)("connected privacy %s window budget", (tool) => {
  it("keeps loading a new group at the tail after 90 standalone calls stream past", async () => {
    const live = serveLive();
    await mountLive(live);
    for (let n = 1; n <= 90; n++) {
      live.push(bash(n));
      await pace(25);
    }
    live.push(search(tool, 1));
    live.push(search(tool, 2));
    await expect.poll(() => text(), { timeout: 5000 }).toContain("hit-001-0-file.ts");
    expect(text()).toContain("hit-002-0-file.ts");
    expect(text()).not.toMatch(/searches? not loaded/);
  });

  it("refetches an evicted group when it is visible again and notes it meanwhile", async () => {
    // The second and later fetches of a group output are slow, so the pending note is observable.
    const live = serveLive((id, nth) =>
      /^cs-(Grep|Glob)-\d+:output$/.test(id) && nth > 1 ? 600 : 0,
    );
    await mountLive(live);
    for (let n = 1; n <= 4; n++) live.push(search(tool, n));
    live.push(divider(1));
    await expect.poll(() => text(), { timeout: 4000 }).toContain("hit-004-0-file.ts");
    // 90 standalone calls (180 bodies) stream past the tail and push the group out of the cache.
    for (let n = 1; n <= 90; n++) {
      live.push(bash(n));
      await pace(25);
    }
    await pace(300);
    const before = live.fetches.get(`cs-${tool}-4:output`) ?? 0;
    const view = scroller();
    // Pause following the way a reader does: reach the bottom, then scroll up to the top.
    view.scrollTop = view.scrollHeight;
    await paint();
    view.scrollTop = Math.max(0, view.scrollTop - view.clientHeight);
    await paint();
    await expect.element(slot().getByRole("button", { name: /jump to latest/i })).toBeVisible();
    view.scrollTop = 0;
    await paint();
    await expect
      .poll(() => text(), { timeout: 4000 })
      .toContain("results of 4 more searches not loaded");
    await expect.poll(() => text(), { timeout: 5000 }).toContain("hit-004-0-file.ts");
    expect(text()).not.toMatch(/searches? not loaded/);
    expect(live.fetches.get(`cs-${tool}-4:output`)).toBeGreaterThan(before);
  });

  it("fetches each visible output at most once in a static view", async () => {
    const live = serveLive();
    await mountLive(live);
    const calls = [bash(1), bash(2), bash(3)];
    for (let g = 0; g < 3; g++) {
      for (let i = 0; i < PER_GROUP; i++) calls.push(search(tool, g * PER_GROUP + i + 1));
      calls.push(divider(g));
    }
    for (const call of calls) live.push(call);
    await expect.poll(() => text(), { timeout: 4000 }).toMatch(/Searched \d+ times/);
    await pace(1500);
    expect(live.fetches.size).toBeGreaterThan(0);
    for (const [id, count] of live.fetches) expect(count, id).toBeLessThanOrEqual(1);
  });
});
