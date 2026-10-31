// Pace (FR-013, contracts/cli.md `--pace`): how often a visible change happens and how often an
// agent needs you, in simulated time.

export interface Pace {
  /** `calm`, `lively`, or the custom text it was parsed from. */
  readonly name: string;
  readonly changeMinMs: number;
  readonly changeMaxMs: number;
  /** Average interval between needs-you moments. */
  readonly needsYouMs: number;
}

/** Default: a visible change every 5 to 15 s and a needs-you moment about every 3 min at 1x. */
export const CALM: Pace = {
  name: "calm",
  changeMinMs: 5_000,
  changeMaxMs: 15_000,
  needsYouMs: 180_000,
};
/** A visible change every 1 to 3 s; needs-you twice as often as calm. */
export const LIVELY: Pace = {
  name: "lively",
  changeMinMs: 1_000,
  changeMaxMs: 3_000,
  needsYouMs: 90_000,
};

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** Longest duration or interval the demo accepts: 30 days of simulated time. */
export const MAX_DURATION_MS = 30 * 24 * 3_600_000;

/**
 * `90s`, `10m`, `1.5h` to milliseconds, at most 30 days. A digit string can overflow to
 * Infinity, which would stop the virtual clock from ever reaching it, so the result is bounded.
 */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(text.trim());
  if (match === null) throw new Error(`Invalid duration "${text}": use a number with s, m, or h`);
  const ms = Math.round(Number(match[1]) * (UNITS[match[2] ?? ""] ?? 0));
  if (!(ms <= MAX_DURATION_MS)) throw new Error(`Invalid duration "${text}": at most 30 days`);
  return ms;
}

/** `calm`, `lively`, or `change=<min>-<max>,needs-you=<interval>`, for example `change=2s-6s,needs-you=90s`. */
export function parsePace(text: string): Pace {
  const name = text.trim();
  if (name === "calm") return CALM;
  if (name === "lively") return LIVELY;
  const fail = (why: string): never => {
    throw new Error(
      `Invalid pace "${text}": ${why}. Use calm, lively, or change=<min>-<max>,needs-you=<interval>`,
    );
  };
  const fields = new Map<string, string>();
  for (const part of name.split(",")) {
    const [key = "", value, ...rest] = part.split("=").map((s) => s.trim());
    if (value === undefined || rest.length > 0) fail(`"${part}" is not key=value`);
    if (key !== "change" && key !== "needs-you") fail(`unknown setting "${key}"`);
    if (fields.has(key)) fail(`"${key}" given twice`);
    fields.set(key, value ?? "");
  }
  const change = fields.get("change") ?? fail("change=<min>-<max> is required");
  const needsYou = fields.get("needs-you") ?? fail("needs-you=<interval> is required");
  const bounds = change.split("-");
  if (bounds.length !== 2) fail(`change "${change}" must be <min>-<max>`);
  const duration = (value: string) => {
    try {
      return parseDuration(value);
    } catch {
      return fail(`"${value}" is not a duration with s, m, or h`);
    }
  };
  const changeMinMs = duration(bounds[0] ?? "");
  const changeMaxMs = duration(bounds[1] ?? "");
  const needsYouMs = duration(needsYou);
  if (changeMinMs <= 0 || needsYouMs <= 0) fail("intervals must be above zero");
  if (changeMaxMs < changeMinMs) fail("the change maximum is below its minimum");
  return { name, changeMinMs, changeMaxMs, needsYouMs };
}

export const formatPace = (pace: Pace): string => pace.name;
