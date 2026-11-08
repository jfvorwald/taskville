import { describe, expect, it, vi } from "vitest";
import { type Locator, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { LiveTab } from "./LiveTab.tsx";
import {
  AGENT,
  build,
  type CallSpec,
  openDetails,
  paint,
  renderConstrained,
  seedStore,
  slot,
} from "./liveKit.tsx";

// M10.02 red: the Live tab as a readable logbook (docs/superpowers/specs/2026-11-08-agent-panel-
// readability-design.md). DOM contract, one entry per tool call or call group:
//   [data-testid=logbook-thread]   contains every entry and every turn divider
//   article[data-testid=logbook-entry]  the entry; it stays an article
//     [data-testid=entry-status]   text Succeeded | Failed | Running | Unfinished | Needs you,
//                                  and data-state succeeded | failed | running | unfinished | needs-you
//     [data-testid=entry-sentence] the one-line sentence
//     [data-testid=entry-duration] muted duration ("26 ms") or "running"; absent when unreported
//     [data-testid=entry-secondary] optional second line
//     button "Details" with aria-expanded; its content lives in [data-testid=entry-details]
//       [data-testid=entry-input-list]  key-value list (known tools)
//       [data-testid=entry-raw-json]    raw JSON (unknown tools only)
//   [data-testid=turn-divider] role=separator, between turns, showing the next turn's time
// Collapsed details are not visible. These tests read visible text (innerText), so an
// implementation may unmount the details or hide them.

const entries = () => page.getByTestId("logbook-entry");
const entryWith = (text: string | RegExp) => entries().filter({ hasText: text });
const part = (entry: Locator, id: string) => entry.getByTestId(id);
const shown = (entry: Locator) => (entry.element() as HTMLElement).innerText;
const sentenceOf = (entry: Locator) => part(entry, "entry-sentence").element().textContent?.trim();
const detailsButton = (entry: Locator) => entry.getByRole("button", { name: /^details\b/i });
const expandedOf = (entry: Locator) => detailsButton(entry).element().getAttribute("aria-expanded");

const write = (n: number, extra: Partial<CallSpec> = {}): CallSpec => ({
  id: `lb-write-${n}`,
  tool: "Write",
  input: { file_path: `/r/docs/file-${n}.md`, content: `body ${n}` },
  filePaths: [`/r/docs/file-${n}.md`],
  durationMs: 3,
  ...extra,
});
const bash = (id: string, command: string, extra: Partial<CallSpec> = {}): CallSpec => ({
  id,
  tool: "Bash",
  input: { command },
  output: { stdout: "", stderr: "", interrupted: false },
  durationMs: 5,
  ...extra,
});

async function show(specs: readonly CallSpec[]) {
  const view = await renderConstrained(specs, 1200);
  await expect.poll(() => entries().elements().length).toBeGreaterThan(0);
  return view;
}

describe("M10.02 one entry per tool call", () => {
  it("shows a status node, sentence, duration and collapsed Details on a vertical thread", async () => {
    await show([bash("lb-1", "pnpm test --filter web\nsecond line", { durationMs: 26 })]);
    const entry = entries();
    expect(entry.elements()).toHaveLength(1);
    const thread = page.getByTestId("logbook-thread").element();
    expect(thread.contains(entry.element())).toBe(true);
    const status = part(entry, "entry-status");
    expect(status.element().textContent).toMatch(/Succeeded/);
    expect(status.element().getAttribute("data-state")).toBe("succeeded");
    expect(sentenceOf(entry)).toBe("Ran pnpm test --filter web");
    expect(part(entry, "entry-duration").element().textContent).toMatch(/26\s?ms/);
    expect(part(entry, "entry-secondary").elements()).toHaveLength(0);
    expect(expandedOf(entry)).toBe("false");
  });

  it.each([
    [
      "Bash",
      { id: "s-bash", tool: "Bash", input: { command: "git status --short\nignored second line" } },
      "Ran git status --short",
    ],
    [
      "Edit",
      {
        id: "s-edit",
        tool: "Edit",
        input: {
          file_path: "/r/src/notes.ts",
          old_string: "OLDLINE",
          new_string: "NEW1\nNEW2\nNEW3",
        },
        filePaths: ["/r/src/notes.ts"],
      },
      "Edited notes.ts +3 −1",
    ],
    [
      "Write",
      {
        id: "s-write",
        tool: "Write",
        input: { file_path: "/r/docs/hello.txt", content: "SENTENCE_LEAK_CHECK" },
        filePaths: ["/r/docs/hello.txt"],
      },
      "Wrote hello.txt",
    ],
    [
      "Grep",
      { id: "s-grep", tool: "Grep", input: { pattern: "attention", path: "/r" } },
      'Searched "attention"',
    ],
    ["Glob", { id: "s-glob", tool: "Glob", input: { pattern: "**/*.ts" } }, 'Searched "**/*.ts"'],
    [
      "Agent",
      {
        id: "s-agent",
        tool: "Agent",
        input: { subagent_type: "reviewer", description: "Review it", prompt: "LONG PROMPT" },
      },
      "Spawned reviewer helper",
    ],
    [
      "Task",
      { id: "s-task", tool: "Task", input: { subagent_type: "explorer", description: "Look" } },
      "Spawned explorer helper",
    ],
    [
      "SendMessage",
      {
        id: "s-send",
        tool: "SendMessage",
        input: { to: "bo", recipient: "bo", recipient_kind: "name", message: "hello there" },
      },
      "Sent bo a message",
    ],
    [
      "WebFetch",
      { id: "s-fetch", tool: "WebFetch", input: { url: "https://docs.example.com/guide?x=1" } },
      "Fetched docs.example.com",
    ],
    [
      "unknown tool",
      { id: "s-x", tool: "Frobnicate", input: { widget: "gear" } },
      "Used Frobnicate",
    ],
  ] as const)(
    "writes the %s sentence from the tool and its key field",
    async (_name, spec, sentence) => {
      await show([{ ...spec, durationMs: 4 } as CallSpec]);
      const entry = entries();
      expect(entry.elements()).toHaveLength(1);
      expect(sentenceOf(entry)).toBe(sentence);
      expect(sentenceOf(entry)).not.toMatch(
        /SENTENCE_LEAK_CHECK|LONG PROMPT|ignored second line|OLDLINE|NEW2/,
      );
    },
  );

  it("says Read 3 files for a run of three Reads, with a node on the thread", async () => {
    await show(
      [1, 2, 3].map((n) => ({
        id: `lb-read-${n}`,
        tool: "Read",
        input: { file_path: `/r/src/f${n}.ts` },
        filePaths: [`/r/src/f${n}.ts`],
        durationMs: 2,
      })),
    );
    const entry = entries();
    expect(entry.elements()).toHaveLength(1);
    expect(sentenceOf(entry)).toBe("Read 3 files");
    expect(part(entry, "entry-status").element().getAttribute("data-state")).toBe("succeeded");
    expect(page.getByTestId("logbook-thread").element().contains(entry.element())).toBe(true);
  });

  it("shows a pending call as Running <Tool> with a running node and 'running' for the duration", async () => {
    await show([
      {
        id: "lb-pending",
        tool: "Bash",
        input: { command: "pnpm test" },
        phase: "running",
      },
    ]);
    const entry = entries();
    expect(sentenceOf(entry)).toMatch(/^Running Bash/);
    const status = part(entry, "entry-status").element();
    expect(status.getAttribute("data-state")).toBe("running");
    expect(status.textContent).toMatch(/Running/);
    expect(part(entry, "entry-duration").element().textContent).toMatch(/running/i);
  });

  it.each([
    ["failed", "Failed"],
    ["unfinished", "Unfinished"],
  ] as const)("exposes a %s call as %s on its node", async (phase, label) => {
    await show([bash("lb-phase", "false", { phase })]);
    const status = part(entries(), "entry-status").element();
    expect(status.textContent).toMatch(new RegExp(label));
    expect(status.getAttribute("data-state")).toBe(phase);
  });
});

describe("M10.02 the secondary line", () => {
  it("shows an Agent's description", async () => {
    await show([
      {
        id: "sec-agent",
        tool: "Agent",
        input: { subagent_type: "general-purpose", description: "Create hello.txt and cat it" },
      },
    ]);
    expect(part(entries(), "entry-secondary").element().textContent?.trim()).toBe(
      "Create hello.txt and cat it",
    );
  });

  it.each([
    [
      "a string message",
      "Both tasks are finished; shutting the team down.",
      "Both tasks are finished",
    ],
    ["a message object", { type: "message", content: "ready to merge" }, "ready to merge"],
  ] as const)("shows a SendMessage's summary from %s", async (_name, message, expected) => {
    await show([
      {
        id: "sec-send",
        tool: "SendMessage",
        input: { to: "bo", recipient: "bo", recipient_kind: "name", message },
      },
    ]);
    expect(part(entries(), "entry-secondary").element().textContent).toContain(expected);
  });

  it("bounds a long message to a short plain-text line", async () => {
    const long = `START ${"word ".repeat(400)}END_MARK`;
    await show([
      {
        id: "sec-long",
        tool: "SendMessage",
        input: { to: "bo", recipient: "bo", recipient_kind: "name", message: long },
      },
    ]);
    const text = part(entries(), "entry-secondary").element().textContent ?? "";
    expect(text).toContain("START");
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toContain("END_MARK");
    expect(part(entries(), "entry-secondary").element().querySelector("*")).toBeNull();
  });

  it("shows a failed Bash's error first line, and nothing for a successful one", async () => {
    await show([
      bash("sec-failed", "cat missing.txt", {
        phase: "failed",
        output: {
          stdout: "",
          stderr: "cat: missing.txt: No such file or directory\nsecond",
          interrupted: false,
        },
      }),
      bash("sec-ok", "echo fine", { output: { stdout: "fine", stderr: "", interrupted: false } }),
      write(1),
    ]);
    const failed = entryWith("Ran cat missing.txt");
    expect(part(failed, "entry-secondary").element().textContent?.trim()).toBe(
      "cat: missing.txt: No such file or directory",
    );
    expect(part(entryWith("Ran echo fine"), "entry-secondary").elements()).toHaveLength(0);
    expect(part(entryWith("Wrote file-1.md"), "entry-secondary").elements()).toHaveLength(0);
  });
});

describe("M10.02 the Details disclosure", () => {
  const edit: CallSpec = {
    id: "d-edit",
    tool: "Edit",
    input: { file_path: "/r/src/notes.ts", old_string: "OLDLINE", new_string: "NEW1\nNEW2\nNEW3" },
    filePaths: ["/r/src/notes.ts"],
    durationMs: 6,
  };

  it("is collapsed by default and hides every body", async () => {
    await show([
      edit,
      write(1, { input: { file_path: "/r/docs/file-1.md", content: "WRITE_BODY_TOKEN" } }),
      bash("d-bash", "echo hi", { output: { stdout: "BASH_OUT_TOKEN", stderr: "" } }),
    ]);
    for (const entry of entries().elements()) {
      const locator = page.elementLocator(entry);
      expect(expandedOf(locator)).toBe("false");
    }
    const text = shown(slot());
    expect(text).not.toMatch(/OLDLINE|NEW2|WRITE_BODY_TOKEN|BASH_OUT_TOKEN/);
    expect(text).not.toMatch(/Edit fragment|Expand output/);
  });

  it("toggles with Enter and with Space", async () => {
    await show([
      write(1, { input: { file_path: "/r/docs/file-1.md", content: "WRITE_BODY_TOKEN" } }),
    ]);
    const entry = entries();
    detailsButton(entry).element().focus();
    expect(document.activeElement).toBe(detailsButton(entry).element());
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => expandedOf(entry)).toBe("true");
    await expect.poll(() => shown(entry)).toContain("WRITE_BODY_TOKEN");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => expandedOf(entry)).toBe("false");
    await userEvent.keyboard(" ");
    await expect.poll(() => expandedOf(entry)).toBe("true");
    await userEvent.keyboard(" ");
    await expect.poll(() => expandedOf(entry)).toBe("false");
    expect(shown(entry)).not.toContain("WRITE_BODY_TOKEN");
  });

  it("opens only the newest failed entry by default", async () => {
    await show([
      bash("nf-1", "cat a.txt", {
        phase: "failed",
        output: { stdout: "", stderr: "cat: a.txt: first failure\n" },
      }),
      bash("nf-2", "cat b.txt", {
        phase: "failed",
        output: { stdout: "", stderr: "cat: b.txt: second failure\nmore detail line" },
      }),
      bash("nf-3", "echo done", { output: { stdout: "all good", stderr: "" } }),
    ]);
    expect(expandedOf(entryWith("Ran cat a.txt"))).toBe("false");
    expect(expandedOf(entryWith("Ran cat b.txt"))).toBe("true");
    expect(expandedOf(entryWith("Ran echo done"))).toBe("false");
    expect(shown(entryWith("Ran cat b.txt"))).toContain("more detail line");
    expect(shown(entryWith("Ran cat a.txt"))).not.toContain("first failure\n");
  });

  it("shows the Edit fragment, the Write content and the Bash output when opened", async () => {
    await show([
      edit,
      write(1, { input: { file_path: "/r/docs/file-1.md", content: "WRITE_BODY_TOKEN" } }),
      bash("d-bash", "echo hi", {
        output: { stdout: "BASH_OUT_1\nBASH_OUT_2", stderr: "" },
      }),
    ]);
    const editEntry = entryWith("Edited notes.ts");
    await openDetails(editEntry);
    expect(shown(editEntry)).toContain("NEW2");
    expect(editEntry.element().querySelector("del")?.textContent).toContain("OLDLINE");
    expect(editEntry.element().querySelector("ins")).not.toBeNull();
    const writeEntry = entryWith("Wrote file-1.md");
    await openDetails(writeEntry);
    expect(shown(writeEntry)).toContain("WRITE_BODY_TOKEN");
    expect(writeEntry.element().querySelectorAll("del, ins")).toHaveLength(0);
    const bashEntry = entryWith("Ran echo hi");
    await openDetails(bashEntry);
    expect(shown(bashEntry)).toContain("BASH_OUT_2");
  });

  it("lists the input of a known tool as key-value pairs, not raw JSON", async () => {
    await show([
      bash("kv", "ls -la", {
        input: { command: "ls -la", description: "List files", timeout: 5000 },
      }),
    ]);
    const entry = entries();
    await openDetails(entry);
    const list = part(entry, "entry-input-list");
    const text = (list.element() as HTMLElement).innerText;
    for (const expected of [/command/i, /ls -la/, /timeout/i, /5000/, /description/i, /List files/])
      expect(text).toMatch(expected);
    expect(part(entry, "entry-raw-json").elements()).toHaveLength(0);
    expect(shown(entry)).not.toMatch(/"command"\s*:/);
  });

  it("shows raw JSON only for an unknown tool", async () => {
    await show([
      { id: "raw", tool: "Frobnicate", input: { widget: "gear", count: 3 }, durationMs: 1 },
    ]);
    const entry = entries();
    expect(shown(entry)).not.toContain("gear");
    await openDetails(entry);
    const raw = part(entry, "entry-raw-json");
    expect((raw.element() as HTMLElement).innerText).toMatch(/"widget":\s*"gear"/);
    expect(part(entry, "entry-input-list").elements()).toHaveLength(0);
  });

  it("keeps 'not reported' inside Details, never on a collapsed entry", async () => {
    await show([
      {
        id: "nr",
        tool: "Write",
        phase: "succeeded",
        filePaths: ["/r/docs/ghost.md"],
      },
    ]);
    const entry = entries();
    expect(expandedOf(entry)).toBe("false");
    expect(shown(slot())).not.toMatch(/not reported/i);
    expect(part(entry, "entry-duration").elements()).toHaveLength(0);
    await openDetails(entry);
    const details = part(entry, "entry-details");
    expect((details.element() as HTMLElement).innerText).toMatch(/not reported/i);
  });
});

describe("M10.02 turn dividers", () => {
  const at = (iso: string) => new Date(iso);
  const minutes = (iso: string) => String(at(iso).getMinutes()).padStart(2, "0");
  const T1 = "2026-11-08T12:00:00Z";
  const T1b = "2026-11-08T12:00:05Z";
  const T2 = "2026-11-08T12:37:00Z";
  const T2b = "2026-11-08T12:37:04Z";

  it("separates entries of different turns with a divider showing the new turn's time", async () => {
    await show([
      write(1, { startedAt: T1 }),
      write(2, { startedAt: T1b }),
      write(3, { startedAt: T2 }),
      write(4, { startedAt: T2b }),
    ]);
    const dividers = page.getByTestId("turn-divider");
    expect(dividers.elements()).toHaveLength(1);
    const divider = dividers.element() as HTMLElement;
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.innerText).toMatch(new RegExp(`\\d{1,2}:${minutes(T2)}`));
    const before = entryWith("Wrote file-2.md").element();
    const after = entryWith("Wrote file-3.md").element();
    expect(before.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page.getByTestId("logbook-thread").element().contains(divider)).toBe(true);
  });

  it("draws no divider within one turn, or when start times are not reported", async () => {
    await show([write(1, { startedAt: T1 }), write(2, { startedAt: T1b }), write(3)]);
    expect(page.getByTestId("turn-divider").elements()).toHaveLength(0);
  });
});

describe("M10.02 privacy mode", () => {
  async function showPrivate() {
    const { calls, evidence } = build([
      {
        id: "p-edit",
        tool: "Edit",
        input: {
          file_path: "/r/src/path.ts",
          old_string: "const oldSecretPlan = 1;",
          new_string: "const newSecretPlan = 2;\nmore1\nmore2",
        },
        filePaths: ["/r/src/path.ts"],
        durationMs: 2,
      },
      {
        id: "p-write",
        tool: "Write",
        input: { file_path: "/r/docs/x.md", content: "confidential text" },
        filePaths: ["/r/docs/x.md"],
        durationMs: 2,
      },
      {
        id: "p-bash",
        tool: "Bash",
        input: { command: "deploy --secret-flag-abc" },
        output: { stdout: "PRIVATE_OUTPUT_TEXT", stderr: "" },
        durationMs: 2,
      },
      ...[1, 2, 3].map((n) => ({
        id: `p-read-${n}`,
        tool: "Read",
        input: { file_path: `/r/src/r${n}.ts` },
        filePaths: [`/r/src/r${n}.ts`],
        durationMs: 1,
      })),
    ]);
    await render(
      <div
        data-testid="agent-panel-tab-slot"
        style={{ height: 1200, width: 400, overflowY: "auto" }}
      >
        <LiveTab
          agentId={AGENT}
          store={seedStore()}
          select={vi.fn()}
          calls={calls}
          evidence={evidence}
          privacy
        />
      </div>,
    );
    await paint();
    await expect.poll(() => entries().elements().length).toBe(4);
  }

  it("keeps sentences with file names and counts but no bodies, even with Details opened", async () => {
    await showPrivate();
    expect(sentenceOf(entryWith("path.ts"))).toMatch(/^Edited path\.ts/);
    expect(sentenceOf(entryWith("x.md"))).toBe("Wrote x.md");
    expect(sentenceOf(entries().nth(2))).toMatch(/^Ran/);
    expect(sentenceOf(entryWith("Read 3 files"))).toBe("Read 3 files");
    for (const entry of entries().elements()) await openDetails(page.elementLocator(entry));
    const text = slot().element().textContent ?? "";
    for (const secret of [
      "oldSecretPlan",
      "newSecretPlan",
      "confidential text",
      "PRIVATE_OUTPUT_TEXT",
      "deploy --secret-flag-abc",
    ])
      expect(text).not.toContain(secret);
    expect(slot().element().querySelector("del, ins")).toBeNull();
    expect(part(slot(), "entry-raw-json").elements()).toHaveLength(0);
  });
});
