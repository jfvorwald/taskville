import { vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { initialState } from "../../../data/domain.ts";
import { createDataStore, type DataStore } from "../../../data/store.ts";
import { LiveTab } from "./LiveTab.tsx";

// Shared helpers for the M5.06 round 5 Live tests. Everything here is synthetic, not raw S-2.
export const PROJECT = "m506-r5";
export const AGENT = "r5-agent";

export interface CallSpec {
  id: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  /** A body whose text is not JSON, or JSON the test serialises itself. */
  inputRaw?: string;
  outputRaw?: string;
  phase?: ToolCallFrame["phase"];
  filePaths?: string[];
  durationMs?: number;
}

export function bodyOf(
  call: string,
  part: "input" | "output",
  text: string,
  masks: EvidenceResponse["masks"] = [],
  project = PROJECT,
): EvidenceResponse {
  return {
    id: `${call}:${part}`,
    projectId: project,
    toolCallId: call,
    part,
    text,
    bytes: new TextEncoder().encode(text).length,
    masks,
    truncated: false,
  };
}

export function build(specs: readonly CallSpec[], agent = AGENT) {
  const calls: ToolCallFrame[] = [];
  const evidence: Record<string, EvidenceResponse> = {};
  for (const spec of specs) {
    const frame: ToolCallFrame = {
      toolCallId: spec.id,
      agentId: agent,
      toolName: spec.tool,
      phase: spec.phase ?? "succeeded",
      filePaths: spec.filePaths ?? [],
      evidence: { input: null, output: null },
      ...(spec.durationMs === undefined ? {} : { durationMs: spec.durationMs }),
    };
    for (const part of ["input", "output"] as const) {
      const raw = part === "input" ? spec.inputRaw : spec.outputRaw;
      const value = part === "input" ? spec.input : spec.output;
      if (raw === undefined && value === undefined) continue;
      const body = bodyOf(spec.id, part, raw ?? JSON.stringify(value));
      evidence[body.id] = body;
      frame.evidence[part] = { id: body.id, status: "stored" };
    }
    calls.push(frame);
  }
  return { calls, evidence };
}

export function seedStore(): DataStore {
  const store = createDataStore();
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(initialState(PROJECT));
  return store;
}

export const slot = () => page.getByTestId("agent-panel-tab-slot");
export const articles = () => slot().getByRole("article");
export const paint = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};
export const turn = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Live tab inside a constrained scrolling slot, so it never has to create its own viewport. */
export function constrained(specs: readonly CallSpec[], store: DataStore, height = 420) {
  const { calls, evidence } = build(specs);
  return (
    <div data-testid="agent-panel-tab-slot" style={{ height, width: 400, overflowY: "auto" }}>
      <LiveTab agentId={AGENT} store={store} select={vi.fn()} calls={calls} evidence={evidence} />
    </div>
  );
}

export async function renderConstrained(specs: readonly CallSpec[], height = 420) {
  const store = seedStore();
  const view = await render(constrained(specs, store, height));
  await paint();
  return {
    store,
    view,
    rerender: async (next: readonly CallSpec[]) => {
      await view.rerender(constrained(next, store, height));
      await paint();
    },
  };
}

export async function renderPlain(specs: readonly CallSpec[], select = vi.fn()) {
  const store = seedStore();
  const { calls, evidence } = build(specs);
  const view = await render(
    <div data-testid="agent-panel-tab-slot">
      <LiveTab agentId={AGENT} store={store} select={select} calls={calls} evidence={evidence} />
    </div>,
  );
  await paint();
  return { store, view };
}

/** Controls, format characters and separators the action card shows as <U+XXXX>, minus newline and tab. */
export const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export const withoutLayout = (text: string) => text.replaceAll("\n", "").replaceAll("\t", "");
