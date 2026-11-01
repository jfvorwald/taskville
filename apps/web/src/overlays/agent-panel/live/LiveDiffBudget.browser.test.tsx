import { diffWordsWithSpace } from "diff";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import { initialState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import { LiveTab } from "./LiveTab.tsx";

// Deterministically exhaust the diff engine budget without freezing the browser.
vi.mock("diff", () => ({ diffWordsWithSpace: vi.fn(() => undefined) }));

it("preserves literal Edit fragments when bounded diff work is exhausted", async () => {
  const store = createDataStore();
  store.getState().reset("budget");
  store.getState().applySnapshotState(initialState("budget"));
  const text = JSON.stringify({
    old_string: "original <literal>",
    new_string: "replacement <literal>",
  });
  const body: EvidenceResponse = {
    id: "input",
    projectId: "budget",
    toolCallId: "edit",
    part: "input",
    text,
    bytes: text.length,
    masks: [],
    truncated: false,
  };
  await render(
    <LiveTab
      agentId="agent"
      store={store}
      select={vi.fn()}
      calls={[
        {
          toolCallId: "edit",
          agentId: "agent",
          toolName: "Edit",
          phase: "succeeded",
          filePaths: [],
          evidence: { input: { id: "input", status: "stored" }, output: null },
        },
      ]}
      evidence={{ input: body }}
    />,
  );
  await expect.element(page.getByRole("article")).toMatchTextContent("original <literal>");
  await expect.element(page.getByRole("article")).toMatchTextContent("replacement <literal>");
  const options = vi.mocked(diffWordsWithSpace).mock.calls[0]?.[2] as
    | { timeout?: number; maxEditLength?: number }
    | undefined;
  expect(options).toEqual(
    expect.objectContaining({ timeout: expect.any(Number), maxEditLength: expect.any(Number) }),
  );
  expect(options?.timeout).toBeGreaterThan(0);
  expect(options?.timeout).toBeLessThanOrEqual(50);
  expect(options?.maxEditLength).toBeGreaterThan(0);
  expect(options?.maxEditLength).toBeLessThanOrEqual(1000);
  expect(page.getByRole("article").element().querySelector("literal")).toBeNull();
});
