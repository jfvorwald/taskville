import { describe, expect, it } from "vitest";
import { resolveTokens, type ThemeMode, type TokenName } from "../../src/themes/core/contract.ts";
import { THEMES } from "../../src/themes/core/themes.ts";

/**
 * WCAG 2.x contrast for every registered theme, in day and night, using the tokens the way the
 * theme controller publishes them (`resolveTokens`: base tokens plus the night override).
 *
 * Pairings (checked against the overlay CSS under src/overlays and src/pairing):
 * - text on surface: header, agent list, settings, overlay host (`--tv-text` on `--tv-surface`)
 * - muted on surface: overlays.module.css, settings notes, agent list meta, PairingNotice body
 * - accent as text on surface: PairingNotice.module.css button label (`color: var(--tv-accent)`)
 * - focus on surface: focus outline (agent-list `outline: 2px solid var(--tv-focus)`), WCAG 1.4.11
 * - text and muted on the hovered agent-list row, which is `--tv-accent` at 25% over the surface
 *   (agent-list.module.css `.row[data-hovered]`); text stays readable while hovered
 * - focus outline on the hovered row (hovered and keyboard-focused at once), 3:1
 * - focus outline over the selected row's inset accent bar (`.row[data-selected]`), 3:1
 * - selected accent bar on the hovered row (selected and hovered at once), 3:1
 */

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

const NAMED_CHANNEL = /^(-?\d*\.?\d+)(%?)$/;

function channel(raw: string): number {
  const m = NAMED_CHANNEL.exec(raw.trim());
  if (m === null) throw new Error(`unreadable color channel: ${raw}`);
  const n = Number(m[1]);
  return m[2] === "%" ? (n / 100) * 255 : n;
}

function alphaOf(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const m = NAMED_CHANNEL.exec(raw.trim());
  if (m === null) throw new Error(`unreadable alpha: ${raw}`);
  const n = Number(m[1]);
  return m[2] === "%" ? n / 100 : n;
}

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` and `rgba(r, g, b, a)` (comma or space). */
export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) {
    const h = v.slice(1);
    if (/^[0-9a-f]{3,4}$/.test(h)) {
      const [r, g, b, a] = [...h].map((c) => Number.parseInt(c + c, 16));
      return [r as number, g as number, b as number, a === undefined ? 1 : a / 255];
    }
    if (/^([0-9a-f]{2}){3,4}$/.test(h)) {
      const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
  }
  const fn = /^rgba?\((.*)\)$/.exec(v);
  if (fn !== null) {
    const parts = (fn[1] as string).split(/[\s,/]+/).filter((p) => p !== "");
    if (parts.length === 3 || parts.length === 4) {
      return [
        channel(parts[0] as string),
        channel(parts[1] as string),
        channel(parts[2] as string),
        alphaOf(parts[3]),
      ];
    }
  }
  throw new Error(`unsupported color format: ${value}`);
}

/** Source-over: `fg` (with its alpha) painted on an opaque `bg`. */
function composite(fg: Rgba, bg: Rgb): Rgb {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}

function opaque(value: string, over: Rgb): Rgb {
  return composite(parseColor(value), over);
}

const WHITE: Rgb = [255, 255, 255];

/** WCAG relative luminance of an sRGB color (channels 0 to 255). */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("contrast helper", () => {
  it("matches known WCAG values", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 AA boundary.
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it("reads hex and rgb()/rgba() and composites alpha over the surface", () => {
    expect(parseColor("#1e90e0")).toEqual([0x1e, 0x90, 0xe0, 1]);
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("rgb(10, 20, 30)")).toEqual([10, 20, 30, 1]);
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30, 0.5]);
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual([10, 20, 30, 0.5]);
    expect(opaque("rgba(0, 0, 0, 0.5)", WHITE)[0]).toBeCloseTo(127.5, 5);
  });
});

interface Pairing {
  name: string;
  min: number;
  ratio: (t: Record<TokenName, string>) => number;
}

/** Hovered agent-list row: `--tv-accent` at 25% over the surface. */
function hoverRow(t: Record<TokenName, string>): Rgb {
  const surface = opaque(t["--tv-surface"], WHITE);
  const accent = parseColor(t["--tv-accent"]);
  return composite([accent[0], accent[1], accent[2], accent[3] * 0.25], surface);
}

const PAIRINGS: readonly Pairing[] = [
  {
    name: "--tv-text on --tv-surface",
    min: 4.5,
    ratio: (t) =>
      contrastRatio(
        opaque(t["--tv-text"], opaque(t["--tv-surface"], WHITE)),
        opaque(t["--tv-surface"], WHITE),
      ),
  },
  {
    name: "--tv-text-muted on --tv-surface",
    min: 4.5,
    ratio: (t) =>
      contrastRatio(
        opaque(t["--tv-text-muted"], opaque(t["--tv-surface"], WHITE)),
        opaque(t["--tv-surface"], WHITE),
      ),
  },
  {
    name: "--tv-accent (as text) on --tv-surface",
    min: 4.5,
    ratio: (t) =>
      contrastRatio(
        opaque(t["--tv-accent"], opaque(t["--tv-surface"], WHITE)),
        opaque(t["--tv-surface"], WHITE),
      ),
  },
  {
    name: "--tv-focus on --tv-surface (non-text, 3:1)",
    min: 3,
    ratio: (t) =>
      contrastRatio(
        opaque(t["--tv-focus"], opaque(t["--tv-surface"], WHITE)),
        opaque(t["--tv-surface"], WHITE),
      ),
  },
  {
    name: "--tv-focus on hovered agent-list row (non-text, 3:1)",
    min: 3,
    ratio: (t) => contrastRatio(opaque(t["--tv-focus"], hoverRow(t)), hoverRow(t)),
  },
  {
    // `.row[data-selected]` paints a 3px inset accent bar; the 2px focus outline (offset -2px)
    // sits on top of its left edge, so the outline must also stand out from the accent.
    name: "--tv-focus on selected-row accent bar (non-text, 3:1)",
    min: 3,
    ratio: (t) =>
      contrastRatio(
        opaque(t["--tv-focus"], opaque(t["--tv-accent"], opaque(t["--tv-surface"], WHITE))),
        opaque(t["--tv-accent"], opaque(t["--tv-surface"], WHITE)),
      ),
  },
  {
    // Selected and hovered at once: the accent bar sits on the hovered background.
    name: "--tv-accent selected bar on hovered agent-list row (non-text, 3:1)",
    min: 3,
    ratio: (t) => contrastRatio(opaque(t["--tv-accent"], hoverRow(t)), hoverRow(t)),
  },
  {
    name: "--tv-text on hovered agent-list row",
    min: 4.5,
    ratio: (t) => contrastRatio(opaque(t["--tv-text"], hoverRow(t)), hoverRow(t)),
  },
  {
    name: "--tv-text-muted on hovered agent-list row",
    min: 4.5,
    ratio: (t) => contrastRatio(opaque(t["--tv-text-muted"], hoverRow(t)), hoverRow(t)),
  },
];

const MODES: readonly ThemeMode[] = ["day", "night"];

describe("theme token contrast (WCAG AA)", () => {
  it("registers all four themes", () => {
    expect(THEMES.map((t) => t.id).sort()).toEqual(["aero", "cyberpunk", "solarpunk", "steampunk"]);
  });

  it("every theme meets AA on every overlay pairing in day and night", () => {
    const misses: string[] = [];
    for (const theme of THEMES) {
      for (const mode of MODES) {
        const tokens = resolveTokens(theme, mode);
        for (const pairing of PAIRINGS) {
          const ratio = pairing.ratio(tokens);
          if (ratio < pairing.min) {
            misses.push(
              `${theme.id} ${mode}: ${pairing.name} is ${ratio.toFixed(2)}:1, needs ${pairing.min}:1`,
            );
          }
        }
      }
    }
    expect(misses, `contrast misses:\n${misses.join("\n")}`).toEqual([]);
  });
});
