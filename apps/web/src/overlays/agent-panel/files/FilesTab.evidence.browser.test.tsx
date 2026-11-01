import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import recorded from "./recorded-feed.fixture.json";

// The same recorded wire data is independently checked by recorded-feed.test.ts.
const fixture: {
  frames: { id: number; data: ToolCallFrame }[];
  evidence: Record<string, EvidenceResponse>;
} = JSON.parse(JSON.stringify(recorded));
const template = fixture.frames.find(
  (f) => f.data.toolName === "Edit" && f.data.phase === "succeeded",
);
if (!template) throw new Error("recorded completed Edit missing");
const editTemplate = template.data;
const inputRef = editTemplate.evidence.input;
const outputRef = editTemplate.evidence.output;
if (!inputRef || !outputRef) throw new Error("recorded Edit input/output missing");
const recordedInput = fixture.evidence[inputRef.id].text;
const recordedOutput = fixture.evidence[outputRef.id].text;
const A = editTemplate.agentId;
const B = "unused-agent";
const NOTES = "/tmp/spike-s2/proj/notes.txt";
const OTHER = "/tmp/spike-s2/proj/other.txt";
const SECRET = "files-test-paired-session";
function seed(store: DataStore, project = "spike") {
  store.getState().reset(project);
  store.getState().applySnapshotState({
    ...initialState(project),
    agents: Object.fromEntries(
      [A, B].map((id) => [
        id,
        {
          id,
          sourceId: "claude-code",
          kind: "subagent" as const,
          registered: true,
          connection: "connected" as const,
          toolCallCount: 0,
          consecutiveToolFailures: 0,
          firstSeenAt: "2026-10-31T12:00:00Z",
          lastSeenAt: "2026-10-31T12:01:00Z",
        },
      ]),
    ),
  });
}
function props(selectedId: string): OverlayProps & { initialTab: "files" } {
  return {
    initialTab: "files",
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_key, fallback) => fallback, set: () => {} },
  };
}

const row = (path: string) => page.getByTestId("file-row").filter({ hasText: path });
type Frame = { id: number; data: ToolCallFrame };
interface BodyRequest {
  id: string;
  signal: AbortSignal | null;
  release: () => void;
  settled: boolean;
}
let frames: Frame[];
let bodies: Record<string, EvidenceResponse>;
let requests: BodyRequest[];
let feedHeaders: Headers | undefined;
let feedUrl: URL | undefined;
let active: number;
let maximum: number;

// Clone recorded calls in memory, preserving the recorded input/output text and metadata.
// Unique call/evidence identities exercise backlog size without a huge committed fixture.
function backlog(count: number) {
  for (let i = 0; i < count; i++) {
    const data: ToolCallFrame = structuredClone(editTemplate);
    data.toolCallId = `recorded-edit-${i}`;
    data.filePaths = [i % 2 === 0 ? NOTES : OTHER];
    for (const part of ["input", "output"] as const) {
      const source = data.evidence[part];
      if (!source) throw new Error("recorded Edit body missing");
      const id = btoa(JSON.stringify(["spike", data.toolCallId, part]))
        .replaceAll("=", "")
        .replaceAll("+", "-")
        .replaceAll("/", "_");
      bodies[id] = { ...fixture.evidence[source.id], id, toolCallId: data.toolCallId };
      data.evidence[part] = { id, status: "stored" };
    }
    frames.push({ id: i + 1, data });
  }
}
const idsFor = (path: string) =>
  frames
    .filter((f) => f.data.filePaths.includes(path))
    .flatMap((f) =>
      [f.data.evidence.input, f.data.evidence.output].flatMap((ref) =>
        ref?.status === "stored" ? [ref.id] : [],
      ),
    );
const detailBodies = () =>
  Array.from(
    page.getByTestId("file-edits").element().querySelectorAll("pre"),
    (p) => p.textContent,
  );
const turn = () => new Promise((resolve) => setTimeout(resolve, 50));
async function openFiles() {
  const store = createDataStore();
  seed(store);
  const view = await render(
    <SessionProvider value={SECRET}>
      <AgentPanel {...props(A)} store={store} />
    </SessionProvider>,
  );
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect.element(row(NOTES)).toBeVisible();
  await expect.element(row(OTHER)).toBeVisible();
  return view;
}
beforeEach(() => {
  frames = [];
  bodies = {};
  requests = [];
  feedHeaders = undefined;
  feedUrl = undefined;
  active = 0;
  maximum = 0;
  selectProject("spike");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.endsWith("/feed")) {
      feedHeaders = new Headers(init?.headers);
      feedUrl = url;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames)
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${frame.id}\nevent: toolcall\ndata: ${JSON.stringify(frame.data)}\n\n`,
                ),
              );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (!url.pathname.startsWith("/v1/evidence/"))
      throw new Error(`unexpected route ${url.pathname}`);
    expect(new Headers(init?.headers).get("X-Taskville-Session")).toBe(SECRET);
    const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
    active++;
    maximum = Math.max(maximum, active);
    return new Promise<Response>((resolve) => {
      let counted = true;
      const finish = () => {
        if (counted) {
          counted = false;
          active--;
        }
      };
      const entry: BodyRequest = {
        id,
        signal: init?.signal ?? null,
        settled: false,
        release() {
          if (entry.settled) return;
          entry.settled = true;
          finish();
          // Deliberately resolve even after abort to exercise the stale-result fence.
          resolve(bodies[id] ? Response.json(bodies[id]) : new Response(null, { status: 404 }));
        },
      };
      requests.push(entry);
      entry.signal?.addEventListener(
        "abort",
        () => {
          finish();
        },
        { once: true },
      );
    });
  });
});
afterEach(() => {
  for (const request of requests) request.release();
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("M5.07 selected-file evidence budget", () => {
  it("lists 1000 recorded calls immediately without fetching evidence before a file click", async () => {
    backlog(1000);
    await openFiles();
    await expect.element(row(NOTES)).toHaveAttribute("data-edit-count", "500");
    await expect.element(row(OTHER)).toHaveAttribute("data-edit-count", "500");
    expect(
      page
        .getByTestId("file-row")
        .elements()
        .map((e) => e.getAttribute("data-file-path")),
    ).toEqual([OTHER, NOTES]);
    expect(feedUrl?.searchParams.get("projectId")).toBe("spike");
    expect(feedHeaders?.get("X-Taskville-Session")).toBe(SECRET);
    await turn();
    expect(requests, "unselected files must not request evidence bodies").toHaveLength(0);
  });

  it("loads only the clicked file with at most four bodies in flight and advances queued work", async () => {
    backlog(8);
    // A recorded gap is still an edit; a completion redelivery is not another edit.
    const gap = structuredClone(frames[0]);
    gap.id = 9;
    gap.data.toolCallId = "recorded-gap";
    gap.data.evidence = { input: null, output: null };
    frames.push(gap, { ...structuredClone(frames[0]), id: 10 });
    await openFiles();
    await row(NOTES).click();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(maximum, "connector evidence body concurrency").toBeLessThanOrEqual(4);
    const selectedIds = idsFor(NOTES);
    expect(requests.every((r) => selectedIds.includes(r.id))).toBe(true);
    const initial = requests.length;
    requests.find((r) => !r.settled)?.release();
    await expect.poll(() => requests.length).toBeGreaterThan(initial);
  });

  it("renders selected recorded bodies, gaps and edit order without loading other files", async () => {
    backlog(8);
    // A recorded gap is still an edit; a completion redelivery is not another edit.
    const gap = structuredClone(frames[0]);
    gap.id = 9;
    gap.data.toolCallId = "recorded-gap";
    gap.data.evidence = { input: null, output: null };
    frames.push(gap, { ...structuredClone(frames[0]), id: 10 });
    await openFiles();
    await row(NOTES).click();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    // Release one batch at a time, allowing any scheduling strategy within the budget.
    for (let batch = 0; batch < 8; batch++) {
      for (const request of requests) request.release();
      await turn();
    }
    const input = recordedInput;
    const output = recordedOutput;
    await expect
      .poll(detailBodies)
      .toEqual([
        input,
        output,
        input,
        output,
        input,
        output,
        input,
        output,
        "not reported",
        "not reported",
      ]);
    await expect.element(row(NOTES)).toHaveAttribute("data-edit-count", "5");
    expect(
      Array.from(page.getByTestId("file-edits").element().querySelectorAll("article"), (e) =>
        e.getAttribute("data-tool-call-id"),
      ),
    ).toEqual([
      "recorded-edit-0",
      "recorded-edit-2",
      "recorded-edit-4",
      "recorded-edit-6",
      "recorded-gap",
    ]);
    expect(requests.map((r) => r.id).sort()).toEqual([...new Set(idsFor(NOTES))].sort());
  });

  it("fences obsolete file responses and cancels remaining work on unmount", async () => {
    backlog(12);
    const view = await openFiles();
    await row(NOTES).click();
    await expect
      .poll(() => requests.filter((r) => idsFor(NOTES).includes(r.id)).length)
      .toBeGreaterThan(0);
    const obsolete = requests.filter((r) => idsFor(NOTES).includes(r.id));
    await row(OTHER).click();
    // Old responses deliberately ignore abort. They cannot populate the current detail.
    for (const request of obsolete) request.release();
    await turn();
    await expect.element(page.getByTestId("file-edits")).toHaveAttribute("data-file-path", OTHER);
    expect(detailBodies()).toEqual(Array(12).fill("not reported"));
    expect(requests.filter((r) => idsFor(NOTES).includes(r.id))).toHaveLength(obsolete.length);
    await expect
      .poll(() => requests.filter((r) => idsFor(OTHER).includes(r.id)).length)
      .toBeGreaterThan(0);
    const pending = requests.filter((r) => !r.settled && !r.signal?.aborted);
    expect(pending.length).toBeGreaterThan(0);
    const count = requests.length;
    await view.unmount();
    expect(pending.every((r) => r.signal?.aborted)).toBe(true);
    for (const request of requests) request.release();
    await turn();
    expect(requests).toHaveLength(count);
    expect(page.getByTestId("file-edits").elements()).toHaveLength(0);
  });
});

// These names are explicit synthetic variants, not claimed raw telemetry from the recording.
describe("panel6262 default production edit-tool evidence", () => {
  it.each(["MultiEdit", "NotebookEdit"])(
    "%s fetches selected recorded evidence through the default Files transport",
    async (toolName) => {
      backlog(4);
      for (const frame of frames) frame.data.toolName = toolName;
      const gap = structuredClone(frames[0]);
      gap.id = 5;
      gap.data.toolCallId = "variant-gap";
      gap.data.evidence = { input: null, output: null };
      frames.push(gap, { ...structuredClone(frames[0]), id: 6 });
      await openFiles();
      await turn();
      expect(requests, "file selection still gates evidence").toHaveLength(0);
      await row(NOTES).click();
      // Assert transport independently of counts/details. A presentation-only fix remains red here.
      await expect
        .poll(() => requests.map((r) => r.id).sort(), { timeout: 1000 })
        .toEqual([...new Set(idsFor(NOTES))].sort());
      expect(maximum).toBeLessThanOrEqual(4);
      for (const request of requests) request.release();
      await expect
        .poll(detailBodies)
        .toEqual([
          recordedInput,
          recordedOutput,
          recordedInput,
          recordedOutput,
          "not reported",
          "not reported",
        ]);
      await expect.element(row(NOTES)).toHaveAttribute("data-edit-count", "3");
      expect(
        Array.from(page.getByTestId("file-edits").element().querySelectorAll("article"), (e) =>
          e.getAttribute("data-tool-call-id"),
        ),
      ).toEqual(["recorded-edit-0", "recorded-edit-2", "variant-gap"]);
      expect(requests.every((r) => idsFor(NOTES).includes(r.id))).toBe(true);
      expect(requests).toHaveLength(4);
    },
  );
});
