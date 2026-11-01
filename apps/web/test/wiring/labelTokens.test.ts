import { describe, expect, it } from "vitest";
import type { ThemeRoot } from "../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../src/themes/cyberpunk/index.ts";
import { watchLabelTokens } from "../../src/wiring/labelTokens.ts";
import { rig, steampunkTheme } from "./fixtures.ts";

/** A document root stand-in: the controller writes tokens here and the label reads them back. */
function fakeRoot() {
  const props = new Map<string, string>();
  const root: ThemeRoot = {
    style: { setProperty: (name, value) => void props.set(name, value) },
    setAttribute: () => {},
  };
  const read = (name: `--${string}`, fallback: string) => props.get(name) ?? fallback;
  return { root, read };
}

describe("agent labels re-read their text tokens when the theme changes", () => {
  it("reports the current tokens first, then the new ones after a theme switch", () => {
    const { theme } = rig();
    const { root, read } = fakeRoot();
    theme.attach(root);

    const seen: { font: string; text: string; muted: string }[] = [];
    const off = watchLabelTokens(theme, (tokens) => seen.push({ ...tokens }), read);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe(cyberpunkTheme.tokens["--tv-text"]);
    expect(seen[0]?.muted).toBe(cyberpunkTheme.tokens["--tv-text-muted"]);
    expect(seen[0]?.font).toBe(cyberpunkTheme.tokens["--tv-font"]);

    theme.setTheme("steampunk");
    const last = seen.at(-1);
    expect(seen.length).toBeGreaterThan(1);
    expect(last?.text).toBe(steampunkTheme.tokens["--tv-text"]);
    expect(last?.muted).toBe(steampunkTheme.tokens["--tv-text-muted"]);
    off();
  });

  it("stops after the disposer runs", () => {
    const { theme } = rig();
    const { root, read } = fakeRoot();
    theme.attach(root);
    const seen: string[] = [];
    const off = watchLabelTokens(theme, (tokens) => seen.push(tokens.text), read);
    off();
    const count = seen.length;
    theme.setTheme("steampunk");
    expect(seen).toHaveLength(count);
  });
});
