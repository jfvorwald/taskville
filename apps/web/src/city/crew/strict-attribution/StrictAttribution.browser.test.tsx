import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Agent, Attention } from "../../../data/domain.ts";
import { StrictAttributionSection } from "../../../overlays/settings/attribution/StrictAttributionSection.tsx";
import { createSettingsStore } from "../../../overlays/settings/store.ts";
import { crewAttribution } from "../attention/attribution.ts";
import { useAttributedView } from "./index.ts";

// M5.13: toggling the setting hides and restores the heuristic link and the red state, through
// the real switch, the real settings store and the real M5.10 crewAttribution.
//
// Intended interface (apps/web/src/city/crew/strict-attribution/index.ts):
//   applyStrictAttribution(view, strict)     // pure; see test/city/crew/strict-attribution
//   useAttributedView(view, store?)          // reads `strictAttribution` from the settings store
//                                            // (default getSettingsStore()) with
//                                            // useSyncExternalStore and returns the view after
//                                            // applyStrictAttribution; memoised, and the same
//                                            // object as the input while strict is off.
// TeamAttribution (M5.10) calls it on { agents, teams, attention } before crewAttribution.
//
// The fixture-driven cases (split-pane replay) live in test/city/crew/strict-attribution; a
// browser test cannot read the fixtures, so the shapes below are the ones that replay produces at
// split-pane seq 17 (heuristic worker prompt on the lead) and seq 40 (pip guessed by its first
// SendMessage, still an unlinked session).
// Run: pnpm --filter @taskville/web test:browser src/city/crew/strict-attribution

const agent = (id: string, extra: Partial<Agent>): Agent =>
  ({ id, kind: "session", registered: true, ...extra }) as Agent;

const VIEW = {
  agents: {
    lead: agent("lead", { kind: "lead", displayName: "proj", teamId: "t1" }),
    pip: agent("pip", {
      displayName: "proj",
      heuristic: { displayName: "pip", kind: "teammate" },
    }),
    bo: agent("bo", { kind: "teammate", displayName: "bo", teamId: "t1" }),
  },
  teams: {
    t1: { id: "t1", leadAgentId: "lead", name: "session-1", memberAgentIds: ["lead", "bo"] },
  },
  attention: [
    {
      agentId: "lead",
      level: "needs_you",
      kind: "permission",
      since: "2026-10-30T12:00:20.868Z",
      heuristic: true,
      reason: { text: "for: pip (Bash)", masked: false, truncated: false },
    },
  ] as unknown as readonly Attention[],
};

function Probe({ store }: { store: ReturnType<typeof createSettingsStore> }) {
  const view = useAttributedView(VIEW as never, store);
  const out = crewAttribution(view as never);
  const guesses = Object.values(view.agents as Record<string, Agent>)
    .filter((a) => a.heuristic !== undefined)
    .map((a) => `${a.id} is guessed as ${a.heuristic?.displayName}`);
  return (
    <>
      <StrictAttributionSection store={store} />
      <p data-testid="red">red: {out.red.join(",") || "none"}</p>
      <p data-testid="label">label: {out.forLabels.lead?.text ?? "none"}</p>
      <p data-testid="guess">guess: {guesses.join(",") || "none"}</p>
      <p data-testid="recorded">bo: {(view.agents as Record<string, Agent>).bo?.kind}</p>
    </>
  );
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const NAME = "Strict teammate attribution";

describe("strict teammate attribution in the crew layer", () => {
  it("shows the heuristic link and red state by default", async () => {
    await render(<Probe store={createSettingsStore(memoryStorage())} />);
    await expect.element(page.getByTestId("red")).toHaveTextContent("red: lead");
    await expect.element(page.getByTestId("label")).toHaveTextContent("label: for: pip");
    await expect.element(page.getByTestId("guess")).toHaveTextContent("pip is guessed as pip");
  });

  it("hides them when switched on and restores them when switched off", async () => {
    await render(<Probe store={createSettingsStore(memoryStorage())} />);
    await page.getByRole("switch", { name: NAME }).click();
    await expect.element(page.getByTestId("red")).toHaveTextContent("red: none");
    await expect.element(page.getByTestId("label")).toHaveTextContent("label: none");
    await expect.element(page.getByTestId("guess")).toHaveTextContent("guess: none");
    await page.getByRole("switch", { name: NAME }).click();
    await expect.element(page.getByTestId("red")).toHaveTextContent("red: lead");
    await expect.element(page.getByTestId("label")).toHaveTextContent("label: for: pip");
    await expect.element(page.getByTestId("guess")).toHaveTextContent("pip is guessed as pip");
  });

  it("still shows a recorded teammate link when strict", async () => {
    await render(<Probe store={createSettingsStore(memoryStorage())} />);
    await page.getByRole("switch", { name: NAME }).click();
    await expect.element(page.getByTestId("recorded")).toHaveTextContent("bo: teammate");
  });

  it("starts strict after a reload when it was left on", async () => {
    const storage = memoryStorage();
    const first = await render(<Probe store={createSettingsStore(storage)} />);
    await page.getByRole("switch", { name: NAME }).click();
    await first.unmount();
    await render(<Probe store={createSettingsStore(storage)} />);
    await expect.element(page.getByTestId("red")).toHaveTextContent("red: none");
    await expect.element(page.getByTestId("label")).toHaveTextContent("label: none");
  });
});
