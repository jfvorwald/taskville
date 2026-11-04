import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { createDataStore } from "../../../data/store.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { getSettingsStore } from "../../settings/store.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";
import { FilesTab } from "./FilesTab.tsx";
import recorded from "./recorded-feed.fixture.json";

// M5.09 red round 3, item 2: the Files tab hides code bodies under Hide code. Two pins, so that
// reverting either half of the fix fails a test: FilesTab honours its `privacy` prop (unit), and
// the connected tab feeds it from the settings store's `privacyMode` (production boundary).

const fixture: {
  frames: { id: number; data: ToolCallFrame }[];
  evidence: Record<string, EvidenceResponse>;
} = JSON.parse(JSON.stringify(recorded));
const edit = fixture.frames.find((f) => f.data.toolName === "Edit" && f.data.phase === "succeeded");
if (!edit) throw new Error("recorded Edit missing");
const A = edit.data.agentId;
const NOTES = "/tmp/spike-s2/proj/notes.txt";
const SECRET = "files-privacy-session";
const BODY = fixture.evidence[edit.data.evidence.input?.id ?? ""]?.text ?? "";

describe("FilesTab privacy prop", () => {
  it("shows recorded bodies when privacy is off (baseline)", async () => {
    const view = await render(
      <FilesTab agentId={A} frames={fixture.frames} evidence={fixture.evidence} privacy={false} />,
    );
    await view.getByTestId("file-row").filter({ hasText: NOTES }).click();
    await expect.element(page.getByTestId("file-edits")).toMatchTextContent("BETA");
  });

  it("hides every body but keeps file names and edit counts when privacy is on", async () => {
    const view = await render(
      <FilesTab agentId={A} frames={fixture.frames} evidence={fixture.evidence} privacy />,
    );
    const row = view.getByTestId("file-row").filter({ hasText: NOTES });
    await expect.element(row).toHaveAttribute("data-edit-count", "1");
    await row.click();
    const panel = page.getByTestId("file-edits");
    await expect.element(panel).toMatchTextContent("Code hidden by the privacy setting");
    expect(panel.element().textContent).not.toContain("BETA");
    expect(panel.element().querySelector("pre")).toBeNull();
    expect(BODY).toContain("BETA");
  });
});

describe("ConnectedFilesTab privacy", () => {
  beforeEach(() => {
    selectProject("spike");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), location.origin);
      if (/^\/v1\/agents\/[^/]+\/feed$/.test(url.pathname)) {
        const frames = fixture.frames.filter((f) => f.data.agentId === A);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const f of frames)
                controller.enqueue(
                  new TextEncoder().encode(
                    `id: ${f.id}\nevent: toolcall\ndata: ${JSON.stringify(f.data)}\n\n`,
                  ),
                );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.pathname.startsWith("/v1/evidence/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
        const body = fixture.evidence[id];
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
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    getSettingsStore().set("privacyMode", false);
    selectProject(DEFAULT_PROJECT_ID);
  });

  async function open() {
    const store = createDataStore();
    store.getState().reset("spike");
    store.getState().applySnapshotState({
      ...initialState("spike"),
      agents: {
        [A]: {
          id: A,
          sourceId: "claude-code",
          kind: "subagent" as const,
          registered: true,
          connection: "connected" as const,
          toolCallCount: 0,
          consecutiveToolFailures: 0,
          firstSeenAt: "2026-10-31T12:00:00Z",
          lastSeenAt: "2026-10-31T12:01:00Z",
        },
      },
    });
    const props: OverlayProps & { initialTab: "files" } = {
      initialTab: "files",
      mode: "live",
      selectors: {
        counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
      },
      selection: { selectedId: A, select: () => {} },
      anchors: createAnchorSource(),
      intents: { available: true, run: () => {} },
      settings: { get: (_key, fallback) => fallback, set: () => {} },
    };
    await render(
      <SessionProvider value={SECRET}>
        <AgentPanel {...props} store={store} />
      </SessionProvider>,
    );
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    const row = page.getByTestId("file-row").filter({ hasText: NOTES });
    await expect.element(row, { timeout: 2500 }).toHaveAttribute("data-edit-count", "1");
    await row.click();
  }

  it("shows bodies when Hide code is off", async () => {
    await open();
    await expect.element(page.getByTestId("file-edits")).toMatchTextContent("BETA");
  });

  it("hides bodies when Hide code is on, and keeps the file row", async () => {
    getSettingsStore().set("privacyMode", true);
    await open();
    const panel = page.getByTestId("file-edits");
    await expect.element(panel).toMatchTextContent("Code hidden by the privacy setting");
    expect(panel.element().textContent).not.toContain("BETA");
  });
});
