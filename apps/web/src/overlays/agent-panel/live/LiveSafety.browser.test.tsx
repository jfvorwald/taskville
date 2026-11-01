import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LiveTab } from "./LiveTab.tsx";
import {
  AGENT,
  articles,
  bodyOf,
  build,
  type CallSpec,
  HIDDEN,
  renderPlain,
  seedStore,
  slot,
  withoutLayout,
} from "./liveKit.tsx";

// M5.06 round 5 items G (visible controls), H (render caps) and the E mask pin.
// Characters are built from code points so no invisible character sits in this source.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BEL = String.fromCodePoint(0x07);
const NEL = String.fromCodePoint(0x85);
const TAG = String.fromCodePoint(0xe0061);
const MIX = `${RLO}${ZWSP}${BEL}${NEL}${TAG}`;
const MARKS = "<U+202E><U+200B><U+0007><U+0085><U+E0061>";

async function textOf(...specs: CallSpec[]) {
  await renderPlain(specs);
  await expect.poll(() => articles().elements().length).toBeGreaterThan(0);
  return articles().element();
}
function expectVisible(card: Element, shown: string) {
  const text = card.textContent ?? "";
  expect(text).toContain(shown);
  expect(HIDDEN.test(withoutLayout(text))).toBe(false);
}

describe("G: hidden and reordering characters render as visible <U+XXXX> markers", () => {
  it("in the Bash command", async () => {
    const card = await textOf({
      id: "g-cmd",
      tool: "Bash",
      input: { command: `echo hi${MIX}there` },
      output: { stdout: "ok", stderr: "" },
      durationMs: 1,
    });
    expectVisible(card, `echo hi${MARKS}there`);
  });

  it("in Bash stdout and stderr, collapsed and expanded", async () => {
    const card = await textOf({
      id: "g-out",
      tool: "Bash",
      input: { command: "run" },
      output: { stdout: `out${MIX}end\nsecond`, stderr: `err${MIX}end` },
      durationMs: 1,
    });
    expectVisible(card, `out${MARKS}end`);
    expectVisible(card, `err${MARKS}end`);
    await articles()
      .getByRole("button", { name: /expand output/i })
      .click();
    expectVisible(card, `out${MARKS}end`);
    expect(card.textContent).toContain("second");
  });

  it("in Write content, keeping newlines", async () => {
    const card = await textOf({
      id: "g-write",
      tool: "Write",
      input: { file_path: "/r5/g/write.txt", content: `first${MIX}\nsecond` },
      filePaths: ["/r5/g/write.txt"],
      durationMs: 1,
    });
    expectVisible(card, `first${MARKS}\nsecond`);
  });

  it("in Edit old and new strings", async () => {
    const card = await textOf({
      id: "g-edit",
      tool: "Edit",
      input: {
        file_path: "/r5/g/edit.ts",
        old_string: `keep ${RLO}${BEL} old`,
        new_string: `keep ${ZWSP}${TAG} new`,
      },
      filePaths: ["/r5/g/edit.ts"],
      durationMs: 1,
    });
    const text = card.textContent ?? "";
    expect(text).toContain("<U+202E><U+0007>");
    expect(text).toContain("<U+200B><U+E0061>");
    expect(HIDDEN.test(withoutLayout(text))).toBe(false);
  });

  it.each([
    ["filePaths", { filePaths: [`/r5/g/evil${MIX}name.txt`] }],
    ["the file_path input", { input: { file_path: `/r5/g/evil${MIX}name.txt`, content: "x" } }],
  ])(
    "shows a path in %s with markers, as plain text and not a vscode link",
    async (_where, extra) => {
      const card = await textOf({
        id: "g-path",
        tool: "Write",
        input: { file_path: "/r5/g/ordinary.txt", content: "x" },
        filePaths: ["/r5/g/ordinary.txt"],
        durationMs: 1,
        ...extra,
      });
      expectVisible(card, `/r5/g/evil${MARKS}name.txt`);
      const links = Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"));
      for (const link of links) {
        expect(link.href.startsWith("vscode:")).toBe(true);
        expect(decodeURIComponent(link.href)).not.toContain("evil");
        expect(link.textContent).not.toContain("evil");
      }
      // The ordinary path stays an editor link (positive control).
      expect(
        links.some((link) => decodeURIComponent(link.href).includes("/r5/g/ordinary.txt")),
      ).toBe(true);
    },
  );
});

describe("E: server mask spans render as masks and the secret is absent", () => {
  it("replaces a non-empty server mask span and never shows the span's text", async () => {
    // Plain words: no client side rule would catch this, so only the server mask span can hide it.
    const secret = "plainly-spoken-secret";
    const text = JSON.stringify({ file_path: "/r5/e/mask.txt", content: `note: ${secret} end` });
    const start = text.indexOf(secret);
    const store = seedStore();
    const { calls } = build([
      { id: "e-mask", tool: "Write", filePaths: ["/r5/e/mask.txt"], durationMs: 1 },
    ]);
    calls[0].evidence.input = { id: "e-mask:input", status: "stored" };
    const body = bodyOf("e-mask", "input", text, [
      { start, end: start + secret.length, kind: "synthetic" },
    ]);
    await render(
      <div data-testid="agent-panel-tab-slot">
        <LiveTab
          agentId={AGENT}
          store={store}
          select={vi.fn()}
          calls={calls}
          evidence={{ [body.id]: body }}
        />
      </div>,
    );
    await expect.poll(() => articles().elements()).toHaveLength(1);
    const shown = slot().element().textContent ?? "";
    expect(shown).toContain("[REDACTED");
    expect(shown).toContain("note: ");
    expect(shown).toContain("end");
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain("plainly");
  });
});

// H: nested arrays. Pretty printing a deep array grows with the square of its depth, so a body
// 1000 deep is two million characters. redactJson overflows the stack somewhere below 2500, and the
// card then falls back to the raw text (5,000 characters at 2500 deep). 12,000 deep is 24,000 raw.
const CAP = 20_000;
const deep = (n: number) => "[".repeat(n) + "]".repeat(n);
const preLengths = (card: Element) =>
  Array.from(card.querySelectorAll("pre"), (pre) => pre.textContent?.length ?? 0);

describe("H: a deep or huge body renders a bounded amount of text", () => {
  it.each([1000, 12_000])(
    "caps a %i-deep nested input at 20,000 characters with a truncated note",
    async (depth) => {
      await renderPlain([
        {
          id: "h-in",
          tool: "WebFetch",
          inputRaw: deep(depth),
          outputRaw: deep(depth),
          durationMs: 1,
        },
      ]);
      await expect.poll(() => articles().elements().length, { timeout: 20_000 }).toBe(1);
      const card = articles().element();
      for (const length of preLengths(card)) expect(length).toBeLessThanOrEqual(CAP);
      expect(card.textContent?.length ?? 0).toBeLessThanOrEqual(CAP * 2 + 1000);
      expect(card.textContent).toMatch(/truncated/i);
    },
    30_000,
  );

  it("a 2500-deep nested input renders a bounded card without hanging (pin)", async () => {
    await renderPlain([
      {
        id: "h-2500",
        tool: "WebFetch",
        inputRaw: deep(2500),
        outputRaw: deep(2500),
        durationMs: 1,
      },
    ]);
    await expect.poll(() => articles().elements().length, { timeout: 20_000 }).toBe(1);
    const card = articles().element();
    for (const length of preLengths(card)) expect(length).toBeLessThanOrEqual(CAP);
    expect(card.textContent?.length ?? 0).toBeLessThanOrEqual(CAP * 2 + 1000);
  }, 30_000);

  it("keeps a 1000-deep Bash output capped after Expand output, with the note still shown", async () => {
    await renderPlain([
      {
        id: "h-bash",
        tool: "Bash",
        input: { command: "deep-output" },
        outputRaw: deep(1000),
        durationMs: 1,
      },
    ]);
    await expect.poll(() => articles().elements().length, { timeout: 20_000 }).toBe(1);
    const card = articles().element();
    expect(card.textContent).toMatch(/truncated/i);
    for (const length of preLengths(card)) expect(length).toBeLessThanOrEqual(CAP);
    await articles()
      .getByRole("button", { name: /expand output/i })
      .click();
    for (const length of preLengths(card)) expect(length).toBeLessThanOrEqual(CAP);
    expect(card.textContent).toMatch(/truncated/i);
  }, 30_000);

  it("caps a huge plain-text Bash stdout after Expand output, with a truncated note", async () => {
    const stdout = Array.from(
      { length: 6000 },
      (_, i) => `line-${String(i).padStart(5, "0")}`,
    ).join("\n");
    await renderPlain([
      {
        id: "h-text",
        tool: "Bash",
        input: { command: "huge-output" },
        output: { stdout, stderr: "" },
        durationMs: 1,
      },
    ]);
    await expect.poll(() => articles().elements().length).toBe(1);
    await articles()
      .getByRole("button", { name: /expand output/i })
      .click();
    const card = articles().element();
    for (const length of preLengths(card)) expect(length).toBeLessThanOrEqual(CAP);
    expect(card.textContent).toMatch(/truncated/i);
  });
});
