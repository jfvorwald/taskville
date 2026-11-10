import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
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
