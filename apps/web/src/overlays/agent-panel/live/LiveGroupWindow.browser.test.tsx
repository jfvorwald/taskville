import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../../data/project.ts";
import { SessionProvider } from "../../../pairing/session.tsx";
import { ConnectedLiveTab } from "./ConnectedLiveTab.tsx";
import { AGENT, articles, build, PROJECT, paint, seedStore } from "./liveKit.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
});

it("keeps every oversized Search group's details reachable and refetches revisited pages", async () => {
  const { calls, evidence } = build(
    Array.from({ length: 160 }, (_, index) => ({
      id: `group-window-${index}`,
      tool: "Grep",
      input: { pattern: `needle-${index}` },
      output: { filenames: [`/synthetic/result-${index}.ts`] },
      filePaths: [`/synthetic/known-${index}.ts`],
    })),
  );
  const reads: string[] = [];
  let active = 0;
  selectProject(PROJECT);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname.startsWith("/v1/evidence/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/evidence/".length));
      reads.push(id);
      active++;
      await Promise.resolve();
      active--;
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
    <div data-testid="agent-panel-tab-slot" style={{ height: 460, width: 400, overflowY: "auto" }}>
      <SessionProvider value="synthetic-group-window-secret">
        <ConnectedLiveTab agentId={AGENT} store={seedStore()} select={vi.fn()} />
      </SessionProvider>
    </div>,
  );
  try {
    await expect.element(articles()).toMatchTextContent("Searched 160 times");
    await userEvent.keyboard("f");
    await articles().getByRole("button", { name: "Expand patterns" }).click();
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await expect.poll(() => active).toBe(0);
    await paint();
    const rows = () => articles().getByRole("listitem");
    // Reproduce the review defect before asking for any new paging control: the original
    // group's first body disappears once later members exhaust its local cache budget.
    await expect.element(rows().first()).toMatchTextContent("needle-0");
    await expect.element(rows().first()).toMatchTextContent("/synthetic/result-0.ts");
    const firstReads = reads.filter((id) => id === "group-window-0:input").length;
    const seen = new Set<number>();
    for (let step = 0; step < 160; step++) {
      await expect
        .poll(() =>
          rows()
            .elements()
            .every((row) => {
              const text = row.textContent ?? "";
              const index = text.match(/needle-(\d+)/)?.[1];
              return index !== undefined && text.includes(`/synthetic/result-${index}.ts`);
            }),
        )
        .toBe(true);
      for (const row of rows().elements()) {
        const index = Number(row.textContent?.match(/needle-(\d+)/)?.[1]);
        expect(Number.isFinite(index)).toBe(true);
        expect(row.textContent).not.toContain("details not loaded");
        expect(row.textContent).not.toContain("details no longer stored");
        seen.add(index);
      }
      const next = articles().getByRole("button", { name: "Next search details" });
      if ((next.element() as HTMLButtonElement).disabled) break;
      await next.click();
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 160 }, (_, n) => n));
    const previous = articles().getByRole("button", { name: "Previous search details" });
    for (let step = 0; step < 160 && !(previous.element() as HTMLButtonElement).disabled; step++) {
      await previous.click();
    }
    await expect.element(rows().first()).toMatchTextContent("needle-0");
    await expect.element(rows().first()).toMatchTextContent("/synthetic/result-0.ts");
    await expect
      .poll(() => reads.filter((id) => id === "group-window-0:input").length)
      .toBeGreaterThan(firstReads);
    expect((previous.element() as HTMLButtonElement).disabled).toBe(true);
    expect(articles().element().getAttribute("aria-setsize")).toBe("1");
  } finally {
    await view.unmount();
  }
});
