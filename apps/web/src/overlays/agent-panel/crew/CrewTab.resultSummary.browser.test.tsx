import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { getSettingsStore } from "../../settings/store.ts";
import { AgentPanel } from "../shell/AgentPanel.tsx";

// M5.25 red (decision #333 D1): the connected AgentPanel passes the store Agent's `resultSummary`
// to the Crew tab, so a finished child shows its recorded summary; a finished child whose
// `agent.finished` had no summary still reads "not reported".

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const base = {
  sourceId: "claude-code",
  registered: true,
  connection: "connected",
  firstSeenAt: new Date(NOW - 60_000).toISOString(),
  lastSeenAt: new Date(NOW).toISOString(),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
};
const finishedAt = new Date(NOW - 5_000).toISOString();

const CODE_SENTINEL = "PRIVACY_CODE_SENTINEL";
const PATH_SENTINEL = "/secret/PRIVACY_PATH_SENTINEL/file.ts";
const RISKY = `Edited ${PATH_SENTINEL}\n\`\`\`ts\nconst ${CODE_SENTINEL} = 1;\n\`\`\``;

function makeStore(summary = "Mapped the parser module and found two dead branches.") {
  const store = createDataStore({ now: () => NOW });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        L: { id: "L", kind: "lead", displayName: "Lead", registeredSeq: 1, ...base },
        withSummary: {
          id: "withSummary",
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Scout",
          registeredSeq: 2,
          finishedAt,
          resultSummary: summary,
          ...base,
        },
        noSummary: {
          id: "noSummary",
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Mute",
          registeredSeq: 3,
          finishedAt,
          ...base,
        },
      },
      teams: {},
      activity: {},
      toolCalls: {},
    } as never,
  });
  return store;
}

const props: OverlayProps = {
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: "L", select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
};

describe("AgentPanel Crew tab result summary (M5.25)", () => {
  it("shows a finished child's recorded summary", async () => {
    render(<AgentPanel {...props} store={makeStore()} initialTab="crew" />);
    await expect.element(page.getByTestId("crew-list")).toBeVisible();
    await expect
      .element(page.getByText("Mapped the parser module and found two dead branches."))
      .toBeInTheDocument();
  });

  it("keeps 'not reported' for a finished child without a summary", async () => {
    render(<AgentPanel {...props} store={makeStore()} initialTab="crew" />);
    await expect.element(page.getByTestId("crew-list")).toBeVisible();
    await expect.element(page.getByText("not reported")).toBeInTheDocument();
  });

  describe("under Hide code", () => {
    afterEach(() => getSettingsStore().set("privacyMode", false));

    it("hides the summary and shows the privacy placeholder, with no summary text anywhere", async () => {
      getSettingsStore().set("privacyMode", true);
      const view = await render(
        <AgentPanel {...props} store={makeStore(RISKY)} initialTab="crew" />,
      );
      await expect.element(page.getByTestId("crew-list")).toBeVisible();
      await expect
        .element(page.getByText("Summary hidden by the privacy setting"))
        .toBeInTheDocument();
      const html = view.container.innerHTML;
      expect(html).not.toContain(CODE_SENTINEL);
      expect(html).not.toContain("PRIVACY_PATH_SENTINEL");
      expect(html).not.toContain("Edited");
    });

    it("still shows 'not reported' for a child without a summary", async () => {
      getSettingsStore().set("privacyMode", true);
      render(<AgentPanel {...props} store={makeStore(RISKY)} initialTab="crew" />);
      await expect.element(page.getByText("not reported")).toBeInTheDocument();
    });

    it("shows the summary again with Hide code off", async () => {
      getSettingsStore().set("privacyMode", false);
      render(<AgentPanel {...props} store={makeStore(RISKY)} initialTab="crew" />);
      await expect.element(page.getByText(CODE_SENTINEL, { exact: false })).toBeInTheDocument();
    });
  });
});
