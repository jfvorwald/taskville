import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { getSettingsStore } from "../../settings/store.ts";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, bodyOf, PROJECT, seedStore } from "./liveKit.tsx";

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

async function mount(calls: ToolCallFrame[], privacy: boolean) {
  evidence = evidence ?? {};
  getSettingsStore().set("privacyMode", privacy);
  serve(calls);
  await render(
    <SessionProvider value="connected-privacy-search-session">
      <div
        data-testid="agent-panel-tab-slot"
        style={{ height: 460, width: 400, overflowY: "auto" }}
      >
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
