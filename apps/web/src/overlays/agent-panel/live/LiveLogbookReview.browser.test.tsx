import { describe, expect, it } from "vitest";
import { type Locator, page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  AGENT,
  type CallSpec,
  constrained,
  openDetails,
  paint,
  renderConstrained,
  seedStore,
  slot,
  turn,
} from "./liveKit.tsx";
import { capLine } from "./logbook.ts";

// M10.02 review-fix round (roborev 7542 and the code review), red first. Contract added to
// LiveLogbook.browser.test.tsx:
//   - a sentence caps its variable part at about 120 characters with an ellipsis; Details keeps it all
//   - a failed Edit, Write or Read reads "Edit failed: <file>", an unfinished one "No result for
//     edit of <file>" (write, read alike); Bash keeps "Ran <command>" in every state
//   - an Agent or SendMessage that succeeded with output.success false is a Failed entry everywhere
//   - a pending permission request marks the single running call of its tool with the needs-you
//     node; with several candidates it is its own entry "Needs you: <Tool>" after the calls
//   - inside entry-status there is an element [data-glyph] whose value differs per state
//   - the Details toggle is named by itself plus its sentence (aria-labelledby)
//   - the turn divider carries its time in aria-label, or in a <time> element
//   - Read and Search groups use the same Details toggle, and split at turn boundaries

const entries = () => page.getByTestId("logbook-entry");
const entryWith = (text: string | RegExp) => entries().filter({ hasText: text });
const part = (entry: Locator, id: string) => entry.getByTestId(id);
const shown = (entry: Locator) => (entry.element() as HTMLElement).innerText;
const sentenceOf = (entry: Locator) => part(entry, "entry-sentence").element().textContent?.trim();
const stateOf = (entry: Locator) =>
  part(entry, "entry-status").element().getAttribute("data-state");
const detailsButton = (entry: Locator) => entry.getByRole("button", { name: /^details\b/i });
const expandedOf = (entry: Locator) => detailsButton(entry).element().getAttribute("aria-expanded");

const write = (n: number, extra: Partial<CallSpec> = {}): CallSpec => {
  const name = `/r/docs/file-${String(n).padStart(2, "0")}.md`;
  return {
    id: `rv-write-${n}`,
    tool: "Write",
    input: { file_path: name, content: `body ${n}` },
    filePaths: [name],
    durationMs: 3,
    ...extra,
  };
};
const bash = (id: string, command: string, extra: Partial<CallSpec> = {}): CallSpec => ({
  id,
  tool: "Bash",
  input: { command },
  output: { stdout: "", stderr: "", interrupted: false },
  durationMs: 5,
  ...extra,
});
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

async function show(specs: readonly CallSpec[], height = 1200) {
  const view = await renderConstrained(specs, height);
  await expect.poll(() => entries().elements().length).toBeGreaterThan(0);
  return view;
}

describe("1: a sentence is capped, Details keeps the whole value", () => {
  const long = (n: number, tag = "v") => `${tag}${"x".repeat(n)}`;
  it.each([
    ["Bash command", bash("c-bash", `${long(5000, "CMD")}\nsecond`), "CMD", /^Ran /],
    [
      "search pattern",
      { id: "c-grep", tool: "Grep", input: { pattern: long(400, "PAT") }, durationMs: 1 },
      "PAT",
      /^Searched /,
    ],
    [
      "recipient",
      {
        id: "c-send",
        tool: "SendMessage",
        input: { to: long(400, "REC"), recipient: long(400, "REC"), message: "hi" },
        durationMs: 1,
      },
      "REC",
      /^Sent /,
    ],
    [
      "subagent type",
      {
        id: "c-agent",
        tool: "Agent",
        input: { subagent_type: long(400, "SUB"), description: "d" },
        durationMs: 1,
      },
      "SUB",
      /^Spawned /,
    ],
  ] as const)("caps a long %s and keeps it in Details", async (_name, spec, tag, verb) => {
    await show([spec as CallSpec]);
    const entry = entries();
    const sentence = sentenceOf(entry) ?? "";
    expect(sentence).toMatch(verb);
    expect(sentence.length).toBeLessThanOrEqual(160);
    expect(sentence).toContain("…");
    await openDetails(entry);
    const details = (part(entry, "entry-details").element() as HTMLElement).textContent ?? "";
    expect(details).toContain(`${tag}${"x".repeat(300)}`);
  });

  it("never splits a surrogate pair when capping a sentence or a line", async () => {
    await show([bash("c-emoji", `${"a".repeat(119)}${"\u{1F600}".repeat(20)}`)]);
    expect(sentenceOf(entries())).not.toMatch(lone);
    expect(capLine(`${"a".repeat(198)}\u{1F600}tail`)).not.toMatch(lone);
    expect(capLine(`${"a".repeat(198)}\u{1F600}tail`).endsWith("…")).toBe(true);
    expect(capLine(`${"a".repeat(199)}\u{1F600}`)).not.toMatch(lone);
  });
});

describe("2: a failed or unfinished Edit, Write or Read does not read as done", () => {
  const edit: CallSpec = {
    id: "f-edit",
    tool: "Edit",
    input: { file_path: "/r/src/notes.ts", old_string: "OLD", new_string: "NEW1\nNEW2" },
    filePaths: ["/r/src/notes.ts"],
  };
  const wr: CallSpec = {
    id: "f-write",
    tool: "Write",
    input: { file_path: "/r/docs/hello.txt", content: "c" },
    filePaths: ["/r/docs/hello.txt"],
  };
  const rd: CallSpec = {
    id: "f-read",
    tool: "Read",
    input: { file_path: "/r/src/f.ts" },
    filePaths: ["/r/src/f.ts"],
  };
  it.each([
    ["failed Edit", { ...edit, phase: "failed" }, "Edit failed: notes.ts"],
    ["failed Write", { ...wr, phase: "failed" }, "Write failed: hello.txt"],
    ["failed Read", { ...rd, phase: "failed" }, "Read failed: f.ts"],
    ["unfinished Edit", { ...edit, phase: "unfinished" }, "No result for edit of notes.ts"],
    ["unfinished Write", { ...wr, phase: "unfinished" }, "No result for write of hello.txt"],
    ["unfinished Read", { ...rd, phase: "unfinished" }, "No result for read of f.ts"],
    ["failed Bash", bash("f-b1", "cat x", { phase: "failed" }), "Ran cat x"],
    ["unfinished Bash", bash("f-b2", "cat y", { phase: "unfinished" }), "Ran cat y"],
  ] as const)("writes the %s sentence", async (_name, spec, sentence) => {
    await show([spec as CallSpec]);
    expect(sentenceOf(entries())).toBe(sentence);
  });
});

describe("3: one state source for Agent and SendMessage", () => {
  const spawn = (extra: Partial<CallSpec> = {}): CallSpec => ({
    id: "s-agent",
    tool: "Agent",
    input: { subagent_type: "reviewer", description: "Review it" },
    output: { success: false, error: "spawn refused by policy" },
    phase: "succeeded",
    durationMs: 4,
    ...extra,
  });
  const send: CallSpec = {
    id: "s-send",
    tool: "SendMessage",
    input: { to: "bo", recipient: "bo", recipient_kind: "name", message: "hello" },
    output: { success: false, error: "no such teammate" },
    phase: "succeeded",
    durationMs: 4,
  };
  it.each([
    ["Agent", spawn(), "spawn refused by policy"],
    ["SendMessage", send, "no such teammate"],
  ] as const)(
    "shows a %s with success false as Failed, with a failure line",
    async (_n, spec, line) => {
      await show([spec as CallSpec]);
      const entry = entries();
      expect(stateOf(entry)).toBe("failed");
      expect(part(entry, "entry-status").element().textContent).toMatch(/Failed/);
      expect(part(entry, "entry-secondary").element().textContent).toContain(line);
    },
  );

  it.each([
    ["Agent", spawn()],
    ["SendMessage", send],
  ] as const)("opens a %s with success false as the newest failed entry", async (_n, spec) => {
    await show([
      bash("s-old", "cat old", { phase: "failed", output: { stderr: "old failure" } }),
      spec as CallSpec,
      bash("s-ok", "echo ok"),
    ]);
    expect(expandedOf(entryWith("Ran cat old"))).toBe("false");
    expect(expandedOf(entryWith(/Spawn failed|Message to bo failed/))).toBe("true");
    expect(expandedOf(entryWith("Ran echo ok"))).toBe("false");
  });
});

describe("4: a pending permission request", () => {
  const SINCE = "2026-11-08T12:00:00Z";
  function pending(tool: string) {
    const store = seedStore();
    const state = store.getState().state;
    if (!state) throw new Error("seed state absent");
    store.getState().applySnapshotState({
      ...state,
      sessions: {
        "rv-session": {
          id: "rv-session",
          agentId: AGENT,
          sourceId: "claude-code",
          provenance: "live",
          firstSeenAt: SINCE,
          startedAt: SINCE,
          startSeq: 1,
          workingDirectory: "/r",
          activity: { activity: "unknown", heuristic: false, since: SINCE },
        },
      },
      requests: {
        "rv-request": {
          id: "rv-request",
          agentId: AGENT,
          sessionId: "rv-session",
          kind: "permission",
          toolName: tool,
          answerable: true,
          openedAt: SINCE,
          state: "open",
          late: false,
          mergedRequestIds: [],
        },
      },
    });
    store.setState({
      attention: [
        {
          agentId: AGENT,
          level: "needs_you",
          kind: "permission",
          since: SINCE,
          requestId: "rv-request",
          heuristic: false,
        },
      ],
    });
    return store;
  }
  async function showPending(tool: string, specs: readonly CallSpec[]) {
    await render(constrained(specs, pending(tool), 1200));
    await paint();
    await expect.poll(() => entries().elements().length).toBeGreaterThan(0);
  }
  const running = (id: string, tool = "Bash", extra: Partial<CallSpec> = {}): CallSpec => ({
    id,
    tool,
    input: tool === "Bash" ? { command: `run ${id}` } : { file_path: `/r/${id}.ts` },
    filePaths: tool === "Bash" ? [] : [`/r/${id}.ts`],
    phase: "running",
    ...extra,
  });

  it("marks the single running call of its tool with the needs-you node", async () => {
    await showPending("Bash", [bash("n-done", "echo done"), running("n-run")]);
    const marked = entries()
      .elements()
      .filter(
        (el) =>
          el.querySelector("[data-testid=entry-status]")?.getAttribute("data-state") ===
          "needs-you",
      );
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("run n-run");
    expect(marked[0]?.querySelector("[data-testid=entry-status]")?.textContent).toMatch(
      /Needs you/,
    );
    expect(entryWith("Needs you: Bash").elements()).toHaveLength(0);
  });

  it("with two running calls shows the request as its own last entry and marks no call", async () => {
    await showPending("Bash", [running("n-a"), running("n-b")]);
    const states = entries()
      .elements()
      .map((el) => ({
        state: el.querySelector("[data-testid=entry-status]")?.getAttribute("data-state"),
        sentence: el.querySelector("[data-testid=entry-sentence]")?.textContent?.trim(),
      }));
    expect(states.filter((s) => s.state === "needs-you")).toEqual([
      { state: "needs-you", sentence: "Needs you: Bash" },
    ]);
    expect(states.filter((s) => s.state === "running")).toHaveLength(2);
    expect(states.at(-1)?.sentence).toBe("Needs you: Bash");
    const last = entries().elements().at(-1) as HTMLElement;
    for (const el of entries().elements().slice(0, -1))
      expect(el.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("never marks calls inside a Read group", async () => {
    await showPending("Read", [running("g1", "Read"), running("g2", "Read")]);
    for (const el of entries().elements())
      if (el.textContent?.includes("Read 2 files"))
        expect(el.querySelector("[data-testid=entry-status]")?.getAttribute("data-state")).not.toBe(
          "needs-you",
        );
  });
});

describe("5: toggling Details while following does not pin the view", () => {
  it("keeps the toggle where it is and pauses follow", async () => {
    const body = Array.from({ length: 25 }, (_, n) => `line ${n}`).join("\n");
    const specs = Array.from({ length: 30 }, (_, i) => {
      const name = `/r/docs/file-${String(i).padStart(2, "0")}.md`;
      return write(i, { input: { file_path: name, content: body } });
    });
    await renderConstrained(specs, 420);
    await expect.poll(() => entries().elements().length).toBeGreaterThan(0);
    const viewport = slot().element();
    await expect
      .poll(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)
      .toBeLessThan(10);
    const entry = entryWith("file-27.md");
    await expect.element(entry).toBeVisible();
    const toggle = detailsButton(entry);
    const before = toggle.element().getBoundingClientRect().top;
    await toggle.click();
    await paint();
    await turn();
    expect(expandedOf(entry)).toBe("true");
    expect(Math.abs(toggle.element().getBoundingClientRect().top - before)).toBeLessThanOrEqual(4);
    await expect.element(slot().getByRole("button", { name: /jump to latest/i })).toBeVisible();
  });
});

describe("6: the default-open failed entry stays open when a newer call fails", () => {
  it("keeps the older failure open and opens the newer one", async () => {
    const failed = (id: string, command: string): CallSpec =>
      bash(id, command, { phase: "failed", output: { stderr: `${command} failed` } });
    const { rerender } = await show([failed("k-a", "cat a"), bash("k-ok", "echo ok")]);
    expect(expandedOf(entryWith("Ran cat a"))).toBe("true");
    await rerender([failed("k-a", "cat a"), bash("k-ok", "echo ok"), failed("k-b", "cat b")]);
    expect(expandedOf(entryWith("Ran cat a"))).toBe("true");
    expect(expandedOf(entryWith("Ran cat b"))).toBe("true");
    expect(expandedOf(entryWith("Ran echo ok"))).toBe("false");
  });
});

describe("7: states differ by more than color", () => {
  it("renders a distinct glyph inside the node of each state", async () => {
    await show([
      bash("v-ok", "echo ok"),
      bash("v-bad", "cat x", { phase: "failed" }),
      bash("v-run", "sleep 9", { phase: "running" }),
    ]);
    const glyph = (text: string) =>
      part(entryWith(text), "entry-status")
        .element()
        .querySelector("[data-glyph]")
        ?.getAttribute("data-glyph");
    const [ok, bad, run] = [glyph("echo ok"), glyph("cat x"), glyph("sleep 9")];
    for (const value of [ok, bad, run]) expect(value).toBeTruthy();
    expect(new Set([ok, bad, run]).size).toBe(3);
  });
});

describe("8: each Details toggle is named by its own entry", () => {
  it("names the toggle with itself and the sentence", async () => {
    await show([bash("t-1", "echo first"), bash("t-2", "echo second")]);
    expect(page.getByRole("button", { name: /^details.*echo first/i }).elements()).toHaveLength(1);
    expect(page.getByRole("button", { name: /^details.*echo second/i }).elements()).toHaveLength(1);
    for (const entry of entries().elements()) {
      const button = page
        .elementLocator(entry)
        .getByRole("button", { name: /^details\b/i })
        .element();
      const ids = (button.getAttribute("aria-labelledby") ?? "").split(/\s+/);
      const sentence = entry.querySelector("[data-testid=entry-sentence]")?.id;
      expect(ids).toContain(button.id);
      expect(sentence).toBeTruthy();
      expect(ids).toContain(sentence);
    }
  });
});

describe("9: the turn divider exposes its time", () => {
  it("has the time in an aria-label or a time element", async () => {
    const t2 = "2026-11-08T12:37:00Z";
    await show([write(1, { startedAt: "2026-11-08T12:00:00Z" }), write(2, { startedAt: t2 })]);
    const divider = page.getByTestId("turn-divider").element();
    const mm = String(new Date(t2).getMinutes()).padStart(2, "0");
    const re = new RegExp(`\\d{1,2}:${mm}`);
    const label = divider.getAttribute("aria-label");
    if (label !== null) expect(label).toMatch(re);
    else {
      const time = page.getByTestId("logbook-thread").element().querySelector("time");
      expect(time?.textContent).toMatch(re);
      expect(divider.getAttribute("role")).toBe("presentation");
    }
  });
});

describe("10: groups use Details and split at turn boundaries", () => {
  const read = (n: number, startedAt: string): CallSpec => ({
    id: `grp-read-${n}`,
    tool: "Read",
    input: { file_path: `/r/src/g${n}.ts` },
    filePaths: [`/r/src/g${n}.ts`],
    startedAt,
    durationMs: 1,
  });
  const search = (n: number): CallSpec => ({
    id: `grp-search-${n}`,
    tool: "Grep",
    input: { pattern: `pat${n}` },
    output: { filenames: [`/r/src/hit${n}.ts`] },
    filePaths: [`/r/src/hit${n}.ts`],
    durationMs: 1,
  });

  it("gives a Read group the same collapsed Details toggle", async () => {
    await show([1, 2, 3].map((n) => read(n, "2026-11-08T12:00:00Z")));
    const entry = entries();
    expect(sentenceOf(entry)).toBe("Read 3 files");
    expect(expandedOf(entry)).toBe("false");
    expect(shown(entry)).not.toContain("g2.ts");
    await openDetails(entry);
    expect(expandedOf(entry)).toBe("true");
    expect(shown(entry)).toContain("g2.ts");
  });

  it("gives a Search group the same collapsed Details toggle", async () => {
    await show([search(1), search(2)]);
    const entry = entries();
    expect(sentenceOf(entry)).toMatch(/^Searched 2 times/);
    expect(expandedOf(entry)).toBe("false");
    await openDetails(entry);
    expect(expandedOf(entry)).toBe("true");
    expect(shown(entry)).toContain("pat2");
  });

  it("splits consecutive reads at a 2 minute gap and draws a divider", async () => {
    await show([
      read(1, "2026-11-08T12:00:00Z"),
      read(2, "2026-11-08T12:00:05Z"),
      read(3, "2026-11-08T12:02:15Z"),
      read(4, "2026-11-08T12:02:18Z"),
    ]);
    expect(entries().elements()).toHaveLength(2);
    expect(entryWith("Read 2 files").elements()).toHaveLength(2);
    expect(page.getByTestId("turn-divider").elements()).toHaveLength(1);
  });
});

describe("11: durations", () => {
  it.each([
    [999, "999 ms"],
    [1000, "1.0 s"],
    [1800, "1.8 s"],
    [183_400, "183.4 s"],
  ] as const)("shows %i ms as %s", async (ms, text) => {
    await show([bash("du", "echo d", { durationMs: ms })]);
    expect(part(entries(), "entry-duration").element().textContent?.trim()).toBe(text);
  });

  it("does not show a negative duration", async () => {
    await show([bash("du-neg", "echo d", { durationMs: -5 })]);
    expect(part(entries(), "entry-duration").elements()).toHaveLength(0);
    expect(shown(entries())).not.toMatch(/-5/);
  });
});
