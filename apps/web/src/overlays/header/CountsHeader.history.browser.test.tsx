import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayMode, OverlayProps } from "../host/types.ts";
import { EMPTY_ATTENTION_FEED } from "./attention.ts";
import { attentionStore } from "./attentionSync.ts";
import { CountsHeader } from "./CountsHeader.tsx";

// M6.10 (#312): in history mode the other-project chips and "Back to Unsorted" come from the live
// global feed and still navigate. They stay visible, grouped under a label that says "Live", so a
// replay is never mistaken for showing the chips' counts at the replayed time. In live mode the
// chips are unlabelled, as before.

const T = "2026-10-30T11:00:00.000Z";
const waiting = (agentId: string, requestId: string) => ({
  agentId,
  level: "needs_you" as const,
  kind: "permission" as const,
  since: T,
  requestId,
  heuristic: false,
});

const COUNTS = { active: 1, needsYou: 0 };

function props(mode: OverlayMode): OverlayProps {
  return {
    mode,
    selectors: {
      counts: {
        subscribe: () => () => {},
        getSnapshot: () => COUNTS,
      },
    },
    selection: { selectedId: null, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: mode === "live", run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

function feedBeta() {
  attentionStore.setState({
    ready: true,
    feed: {
      beta: {
        projectId: "beta",
        name: "Beta",
        attention: [waiting("b1", "r-1"), waiting("b2", "r-2")],
      },
    },
  });
}

afterEach(() => {
  attentionStore.setState({ feed: EMPTY_ATTENTION_FEED, ready: false });
  selectProject(DEFAULT_PROJECT_ID);
});

describe("CountsHeader: chips while replaying (M6.10 b)", () => {
  it("keeps the other-project chip visible in history, inside a group labelled Live", async () => {
    feedBeta();
    await render(<CountsHeader {...props("history")} />);
    const group = page.getByRole("group", { name: /live/i });
    await expect.element(group).toBeVisible();
    await expect.element(group.getByRole("button", { name: "Beta: 2 need you" })).toBeVisible();
  });

  it("keeps Back to Unsorted in the Live group, and it still navigates", async () => {
    feedBeta();
    selectProject("beta");
    await render(<CountsHeader {...props("history")} />);
    const group = page.getByRole("group", { name: /live/i });
    const back = group.getByRole("button", { name: "Back to Unsorted" });
    await expect.element(back).toBeVisible();
    await back.click();
    await expect
      .element(page.getByRole("button", { name: "Back to Unsorted" }))
      .not.toBeInTheDocument();
  });

  it("does not label the chips in live mode", async () => {
    feedBeta();
    await render(<CountsHeader {...props("live")} />);
    await expect.element(page.getByRole("button", { name: "Beta: 2 need you" })).toBeVisible();
    await expect.element(page.getByRole("group", { name: /live/i })).not.toBeInTheDocument();
  });
});
