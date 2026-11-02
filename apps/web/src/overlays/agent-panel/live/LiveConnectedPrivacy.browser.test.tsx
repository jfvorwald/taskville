import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { getSettingsStore } from "../../settings/store.ts";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, build, PROJECT, seedStore } from "./liveKit.tsx";

// M5.09 red round 4, items 2 and 6: the connected Live tab follows the settings store's
// `privacyMode` while mounted, and a caller cannot override it with a `privacy` prop.

const { calls, evidence } = build([
  {
    id: "cp-write",
    tool: "Write",
    input: { file_path: "/r/docs/conn.md", content: "SENTINEL_CONNECTED_BODY" },
    filePaths: ["/r/docs/conn.md"],
  },
  {
    id: "cp-bash",
    tool: "Bash",
    input: { command: "echo SENTINEL_CONNECTED_CMD" },
    output: { stdout: "SENTINEL_CONNECTED_OUT", stderr: "" },
  },
]);
const slot = () => page.getByTestId("agent-panel-tab-slot");

beforeEach(() => {
  selectProject(PROJECT);
  getSettingsStore().set("privacyMode", false);
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
      const body = evidence[decodeURIComponent(url.pathname.slice("/v1/evidence/".length))];
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        {
          once: true,
        },
      );
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  getSettingsStore().set("privacyMode", false);
  selectProject(DEFAULT_PROJECT_ID);
});

async function mount(extra: object = {}) {
  await render(
    <SessionProvider value="connected-privacy-session">
      <div data-testid="agent-panel-tab-slot">
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} {...extra} />
      </div>
    </SessionProvider>,
  );
  await expect
    .poll(() => slot().element().textContent ?? "", { timeout: 4000 })
    .toContain("conn.md");
}

describe("ConnectedLiveTab privacy", () => {
  it("shows bodies when Hide code is off", async () => {
    await mount();
    await expect
      .poll(() => slot().element().textContent, { timeout: 4000 })
      .toContain("SENTINEL_CONNECTED_CMD");
  });

  it("hides every body when Hide code is on, keeping the file name", async () => {
    getSettingsStore().set("privacyMode", true);
    await mount();
    await new Promise((r) => setTimeout(r, 400));
    expect(slot().element().innerHTML).not.toMatch(/SENTINEL_/);
    expect(slot().element().textContent).toContain("conn.md");
    expect(slot().element().textContent).toContain("Code hidden by the privacy setting");
  });

  it("follows the setting while mounted, in both directions", async () => {
    await mount();
    await expect
      .poll(() => slot().element().textContent, { timeout: 4000 })
      .toContain("SENTINEL_CONNECTED_CMD");
    getSettingsStore().set("privacyMode", true);
    await expect.poll(() => slot().element().innerHTML).not.toMatch(/SENTINEL_/);
    getSettingsStore().set("privacyMode", false);
    await expect
      .poll(() => slot().element().textContent, { timeout: 4000 })
      .toContain("SENTINEL_CONNECTED_CMD");
  });

  it("cannot be overridden by a caller's privacy prop", async () => {
    getSettingsStore().set("privacyMode", true);
    await mount({ privacy: false });
    await new Promise((r) => setTimeout(r, 400));
    expect(slot().element().innerHTML).not.toMatch(/SENTINEL_/);
  });
});
