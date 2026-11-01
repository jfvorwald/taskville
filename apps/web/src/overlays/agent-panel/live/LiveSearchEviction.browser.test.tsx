import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, articles, build, PROJECT, seedStore } from "./liveKit.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("M5.17 deferred medium 6450: grouped Search output eviction", () => {
  it.each(["frame", "410"] as const)(
    "shows missing output details per search when %s reports eviction, retaining known paths",
    async (channel) => {
      const { calls, evidence } = build(
        [1, 2].map((n) => ({
          id: `m517-search-${n}`,
          tool: "Grep",
          input: { pattern: `needle-${n}` },
          output: { filenames: [`/synthetic/result-only-${n}.ts`] },
          filePaths: [`/synthetic/known-${n}.ts`],
        })),
      );
      for (const call of calls) {
        const ref = call.evidence.output;
        if (!ref) throw new Error("Synthetic output reference missing");
        if (channel === "frame") ref.status = "evicted";
      }
      const goneRequests: string[] = [];
      selectProject(PROJECT);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = new URL(String(input), location.origin);
        if (url.pathname.startsWith("/v1/evidence/")) {
          const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
          if (id.endsWith(":output")) {
            goneRequests.push(id);
            return new Response(null, { status: 410 });
          }
          return Response.json(evidence[id]);
        }
        if (!url.pathname.endsWith("/feed")) throw new Error("Unexpected synthetic route");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              calls.forEach((data, i) => {
                controller.enqueue(
                  new TextEncoder().encode(
                    `id: ${i + 1}\nevent: toolcall\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              });
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      });
      await render(
        <div
          data-testid="agent-panel-tab-slot"
          style={{ height: 460, width: 400, overflowY: "auto" }}
        >
          <SessionProvider value="synthetic-m517-search">
            <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
          </SessionProvider>
        </div>,
      );
      await expect.element(articles()).toMatchTextContent("Searched 2 times");
      await articles().getByRole("button", { name: "Expand patterns" }).click();
      await expect.element(articles()).toMatchTextContent("needle-2");
      if (channel === "410") await expect.poll(() => goneRequests.length).toBe(2);
      const rows = articles().getByRole("listitem");
      await expect
        .poll(() =>
          rows.elements().every((row) => row.textContent?.includes("details no longer stored")),
        )
        .toBe(true);
      expect(rows.elements()).toHaveLength(2);
      rows.elements().forEach((row, i) => {
        expect(row.textContent).toContain(`needle-${i + 1}`);
        expect(row.textContent).toContain(`/synthetic/known-${i + 1}.ts`);
        expect(row.textContent).not.toContain("result-only");
        expect(row.textContent).not.toContain("not reported");
      });
      expect(goneRequests).toHaveLength(channel === "410" ? 2 : 0);
    },
  );
});
