import { describe, expect, it } from "vitest";
import { createTranscriptMapper } from "../../../src/claude-code/transcripts/index.ts";
import { assistantToolUse, T, toolResult } from "./fixtures.ts";

// Final fix round (M8.02, roborev 7451). Leaf strings are redacted whole first (the line cap
// bounds them), then cut, so no cut point can leave part of a secret. Property names are
// classified by their full text before they are shortened.

const KIB = 1024;
// Built at run time so no credential-shaped literal sits in the repository.
const PASSWORD = ["Zq9xW4", "vLm2Rt", "8NbK7c"].join("");
const USER = "alice";

function run(lines: object[]): { evidence: string; events: string } {
  const mapper = createTranscriptMapper({ projectId: "proj-1" });
  const evidence: unknown[] = [];
  const events: unknown[] = [];
  lines.forEach((line, i) => {
    const r = mapper.mapLine(JSON.stringify(line), i + 1);
    evidence.push(...(r.evidence ?? []));
    events.push(...r.events);
  });
  return { evidence: JSON.stringify(evidence), events: JSON.stringify(events) };
}

const windows = (s: string, n: number): string[] =>
  Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n));

describe("a URL credential straddling a cut point", () => {
  const head = `https://${USER}:`;
  const url = `${head}${PASSWORD}@example.com/repo.git`;

  // `inside` characters of the password precede the boundary.
  const placed = (boundary: number, inside: number): string =>
    `${"p".repeat(boundary - head.length - inside)}${url}${"q".repeat(boundary)}`;

  for (const [name, boundary] of [
    ["64 KiB pre-cut", 64 * KIB],
    ["8 KiB cut", 8 * KIB],
  ] as const) {
    for (const inside of [1, 3, 6, 10]) {
      it(`leaves no fragment of the password at the ${name} with ${inside} characters before it`, () => {
        const output = placed(boundary, inside);
        const { evidence, events } = run([
          assistantToolUse("toolu_U", "Bash", { command: "git clone" }, { ts: T(0) }),
          toolResult("toolu_U", output, { ts: T(1) }),
        ]);
        const all = evidence + events;
        for (const w of windows(PASSWORD, 6)) expect(all, `window ${w}`).not.toContain(w);
        expect(all).not.toContain(`${USER}:${PASSWORD.slice(0, 3)}`);
        expect(all).not.toContain(`${USER}:${PASSWORD.slice(0, 1)}`);
      });
    }
  }

  it("masks the credential in a tool input as well", () => {
    const { evidence } = run([
      assistantToolUse(
        "toolu_I",
        "Bash",
        { command: `${"p".repeat(64 * KIB - head.length - 4)}${url}` },
        { ts: T(0) },
      ),
    ]);
    for (const w of windows(PASSWORD, 6)) expect(evidence, `window ${w}`).not.toContain(w);
  });
});

describe("long sensitive property names", () => {
  const longKey = `${"X".repeat(300)}_PASSWORD`;
  const value = "plainvalue123";

  it("masks the value of a short sensitive key (control)", () => {
    const { evidence } = run([
      assistantToolUse("toolu_S", "Bash", { command: "env", DB_PASSWORD: value }, { ts: T(0) }),
    ]);
    expect(evidence).not.toContain(value);
  });

  it("masks the value of a key whose sensitive suffix is past the shortening limit", () => {
    const { evidence, events } = run([
      assistantToolUse("toolu_L", "Bash", { command: "env", [longKey]: value }, { ts: T(0) }),
    ]);
    expect(evidence + events).not.toContain(value);
  });

  it("bounds the stored key itself", () => {
    const { evidence } = run([
      assistantToolUse("toolu_L", "Bash", { command: "env", [longKey]: value }, { ts: T(0) }),
    ]);
    const parsed = JSON.parse(evidence) as { input: Record<string, unknown> }[];
    for (const k of Object.keys(parsed[0]?.input ?? {})) {
      expect(k.length).toBeLessThanOrEqual(256 + 64);
      expect(k).not.toBe(longKey);
    }
  });

  it("masks a long key with a sensitive _TOKEN suffix in a tool output too", () => {
    const { evidence } = run([
      assistantToolUse("toolu_T", "Bash", { command: "env" }, { ts: T(0) }),
      toolResult("toolu_T", [{ type: "json", data: { [`${"Y".repeat(400)}_TOKEN`]: value } }], {
        ts: T(1),
      }),
    ]);
    expect(evidence).not.toContain(value);
  });
});
