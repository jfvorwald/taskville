import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createDataStore } from "../../../data/store.ts";
import "../../../styles/tokens.css";
import { themeController } from "../../../themes/core/themes.ts";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { AgentPanel } from "./AgentPanel.tsx";

// M10.03 review-fix red: the finished Crew node (--tv-ok) must stand out from the panel surface
// in every theme, in day and night: contrast of at least 3:1 (WCAG non-text contrast).

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const mk = (id: string, over: Record<string, unknown>) => ({
  id,
  sourceId: "claude-code",
  registered: true,
  connection: "connected",
  firstSeenAt: iso(-60_000),
  lastSeenAt: iso(0),
  toolCallCount: 0,
  consecutiveToolFailures: 0,
  ...over,
});

const store = (() => {
  const s = createDataStore({ now: () => NOW });
  s.setState({
    projectId: "proj-1",
    connection: "live",
    attention: [],
    state: {
      agents: {
        L: mk("L", { kind: "lead", displayName: "Lead", registeredSeq: 1 }),
        d: mk("d", {
          kind: "subagent",
          parentAgentId: "L",
          displayName: "Done",
          registeredSeq: 2,
          finishedAt: iso(-1000),
        }),
      },
      teams: {},
      activity: {},
      toolCalls: {},
    } as unknown as NonNullable<ReturnType<typeof s.getState>["state"]>,
  });
  return s;
})();

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

/** sRGB color in any computed form (rgb, rgba, color(srgb ...)) to 0..1 channels. */
function channels(css: string): [number, number, number] {
  const m = css.match(/^(?:rgba?|color)\(\s*(?:srgb\s+)?([^)]*)\)/);
  if (!m?.[1]) throw new Error(`unparseable color ${css}`);
  const nums = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(Number);
  const scale = css.startsWith("color(") ? 1 : 255;
  return nums.map((n) => n / scale) as [number, number, number];
}
function luminance(css: string): number {
  const [r, g, b] = channels(css).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const saved = themeController.store.getState();
let detach: (() => void) | undefined;
afterEach(() => {
  detach?.();
  detach = undefined;
  themeController.setTheme(saved.themeId);
  themeController.setMode(saved.mode);
});

describe("finished Crew node contrast", () => {
  for (const theme of ["aero", "solarpunk", "steampunk"] as const) {
    for (const mode of ["day", "night"] as const) {
      it(`is at least 3:1 against the panel surface on ${theme} (${mode})`, async () => {
        themeController.setTheme(theme);
        themeController.setMode(mode);
        detach = themeController.attach(document.documentElement);
        await render(<AgentPanel {...props} store={store} initialTab="crew" />);
        const node = page.getByTestId("crew-row-dot").element();
        const fill = getComputedStyle(node).backgroundColor;
        const surface = getComputedStyle(page.getByTestId("agent-panel").element()).backgroundColor;
        expect(contrast(fill, surface)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
