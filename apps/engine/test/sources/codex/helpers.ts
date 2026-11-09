import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IngestPipeline } from "../../../src/ingest/index.ts";
import { CodexSource } from "../../../src/sources/codex/index.ts";
import type { Storage } from "../../../src/storage/index.ts";
import { fixedNow } from "../claude-code/helpers.ts";

export { fixedNow, hookId, T0, useProjects } from "../claude-code/helpers.ts";

/** The S-5 recordings (fixtures/codex): every hook ran in /tmp/s5-run/proj. */
export const CODEX_FIXTURES = join(import.meta.dirname, "../../../../../fixtures/codex");
export const FIXTURE_CWD = "/tmp/s5-run/proj";
export const PROJECT = "codex-proj";

/** The raw hook payloads of a recorded stream, in receive order (lines are `{ t_ms, payload }`). */
export function fixtureHooks(name: string): Record<string, unknown>[] {
  return readFileSync(join(CODEX_FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { payload: Record<string, unknown> }).payload);
}

/** The Codex source over the real mapper (`mapCodexHook`) and the M1 ingest pipeline. */
export function makeCodexSource(storage: Storage): CodexSource {
  const pipeline = new IngestPipeline({ storage, now: fixedNow });
  return new CodexSource({ pipeline, storage, now: fixedNow });
}
