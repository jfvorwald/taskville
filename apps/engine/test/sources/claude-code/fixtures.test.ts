import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_HOOKS_PATH,
  CLAUDE_CODE_SOURCE_ID,
  registerClaudeCodeRoutes,
} from "../../../src/sources/claude-code/index.ts";
import { bearer, CLI_TOKEN, makeApp, postJson } from "../../http/helpers.ts";
import { makeSource, useProjects } from "./helpers.ts";

// Spike S-2 recordings (fixtures/claude-code/{team,subagent}): every hook ran in
// /tmp/spike-s2/proj. Lines are { seq, offset_ms, input } with `input` the raw hook JSON.
const FIXTURES = join(import.meta.dirname, "../../../../../fixtures/claude-code");
const STREAMS = [
  "team/in-process.jsonl",
  "team/split-pane.jsonl",
  "team/split-pane-speculative.jsonl",
  "subagent/nested.jsonl",
  "subagent/parallel.jsonl",
];
const URL = `http://127.0.0.1:4807${CLAUDE_CODE_HOOKS_PATH}`;

function hooks(file: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { input: Record<string, unknown> }).input);
}

async function postAll(db: ReturnType<typeof useProjects>, file: string) {
  const { app } = makeApp();
  const { source } = makeSource(db());
  registerClaudeCodeRoutes(app, source);
  const payloads = hooks(file);
  const routed: string[] = [];
  for (const [i, payload] of payloads.entries()) {
    const res = await app.request(
      URL,
      postJson({ sourceEventId: `${file}#${i}`, payload }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    routed.push(body.projectId);
    for (const result of body.results) expect(result.status).toBe("accepted");
  }
  return { count: payloads.length, routed };
}

describe("S-2 fixtures through POST /v1/sources/claude-code/hooks", () => {
  describe("with the spike folder configured as a project root", () => {
    const db = useProjects([
      { id: "spike", roots: ["/tmp/spike-s2/proj"] },
      { id: "spike-parent", roots: ["/tmp/spike-s2"] },
      { id: "spike-evil", roots: ["/tmp/spike-s2/pro"] },
    ]);

    for (const file of STREAMS) {
      it(`lands every hook of ${file} in the project whose root is the cwd`, async () => {
        const { count, routed } = await postAll(db, file);
        expect(count).toBeGreaterThan(0);
        expect(new Set(routed)).toEqual(new Set(["spike"]));
        const events = [...db().events("spike", 1)];
        expect(events).toHaveLength(count);
        expect(events.every((e) => e.sourceId === CLAUDE_CODE_SOURCE_ID && !e.late)).toBe(true);
        for (const other of ["unsorted", "spike-parent", "spike-evil"]) {
          expect([...db().events(other, 1)], other).toHaveLength(0);
        }
      });
    }
  });

  describe("with no matching root", () => {
    const db = useProjects([{ id: "other", roots: ["/work/other"] }]);

    it("lands every hook in Unsorted", async () => {
      const { count, routed } = await postAll(db, "team/in-process.jsonl");
      expect(new Set(routed)).toEqual(new Set(["unsorted"]));
      expect([...db().events("unsorted", 1)]).toHaveLength(count);
      expect([...db().events("other", 1)]).toHaveLength(0);
    });
  });
});
