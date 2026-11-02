import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { getSettingsStore } from "../../settings/store.ts";
import { AgentPanel } from "./AgentPanel.tsx";

// M5.23 red (issue #338): under Hide code the header's current file must not carry content from
// a recorded path. The panel reads the Hide code setting from the settings store.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const MULTI = "/r/src/a.ts\nconst PATH_SENTINEL_HEADER = secret();\nexport {};";
const LONG = `/r/${"a".repeat(1990)}/PATH_SENTINEL_LONG/${"b".repeat(1990)}/end.ts`;

function mount(path: string) {
  const store = createDataStore({ now: () => NOW });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        s1: {
          id: "s1",
          sourceId: "claude-code",
          kind: "subagent",
          registered: true,
          connection: "connected",
          firstSeenAt: new Date(NOW - 5000).toISOString(),
          lastSeenAt: new Date(NOW).toISOString(),
          toolCallCount: 0,
          consecutiveToolFailures: 0,
          registeredSeq: 1,
        },
      },
      teams: {},
      activity: {},
      toolCalls: {
        c1: {
          id: "c1",
          agentId: "s1",
          phase: "running",
          toolName: "Edit",
          filePaths: [path],
          evidenceIds: [],
          startSeq: 1,
        },
      },
    } as unknown as NonNullable<ReturnType<typeof store.getState>["state"]>,
  });
  const props: OverlayProps = {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: "s1", select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
  return render(<AgentPanel {...props} store={store} />);
}

afterEach(() => getSettingsStore().set("privacyMode", false));

async function header(path: string) {
  const view = await mount(path);
  const file = page.getByTestId("agent-panel-file");
  await expect.element(file).toBeVisible();
  return {
    text: file.element().textContent ?? "",
    html: view.container.innerHTML,
  };
}

describe("AgentPanel header file under privacy", () => {
  it("shows the path with Hide code off (baseline)", async () => {
    const { text } = await header("/r/src/a.ts");
    expect(text).toContain("/r/src/a.ts");
  });

  it("hides a multi-line path", async () => {
    getSettingsStore().set("privacyMode", true);
    const { text, html } = await header(MULTI);
    expect(text).toContain("path hidden");
    for (const out of [text, html]) {
      expect(out).not.toContain("PATH_SENTINEL_HEADER");
      expect(out).not.toContain("secret()");
    }
  });

  it("bounds a 4,000 character path", async () => {
    getSettingsStore().set("privacyMode", true);
    const { text, html } = await header(LONG);
    for (const out of [text, html]) {
      expect(out).not.toContain(LONG);
      expect(out).not.toContain("PATH_SENTINEL_LONG");
    }
    expect(text.length).toBeLessThan(300);
  });
});
