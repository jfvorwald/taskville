import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type EventBatchResponse,
  type IngestResult,
  MAX_BATCH_BYTES,
  type StoredEnvelope,
} from "@taskville/protocol";
import { isAbort } from "../client.ts";
import type { Io } from "../context.ts";
import { parseCommand, printJson, required } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";
import { batches, parseJsonl } from "../jsonl.ts";
import { readSse } from "../sse.ts";
import { fetchSnapshot } from "./status.ts";

const INGEST = "taskville events ingest --file <path.jsonl> [--json]";
const FOLLOW = "taskville events follow --project <id> [--after N] [--json]";
/** contracts/cli.md: batches of 1,000; also kept under the engine's 5 MB body limit. */
const BATCH_EVENTS = 1_000;
const BATCH_BYTES = MAX_BATCH_BYTES - 64 * 1024;

export async function events(io: Io, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "ingest") return ingest(io, rest);
  if (sub === "follow") return follow(io, rest);
  throw new CliError(EXIT.failure, `Unknown events command\nUsage: ${INGEST}\n       ${FOLLOW}`);
}

/** Rejections the CLI makes before sending: a line that is not JSON, or one too large to post. */
type LocalRejection = {
  status: "rejected";
  error: { code: "invalid_envelope" | "event_too_large"; message: string };
};
type LineResult = { line: number } & (IngestResult | LocalRejection);

async function ingest(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(io, args, { file: { type: "string" } }, INGEST);
  const path = resolve(io.cwd, required(values, "file", INGEST));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(EXIT.failure, `Cannot read ${path}: ${(error as Error).message}`);
  }
  const lines = parseJsonl(text);
  // A line that is not JSON is rejected here as invalid_envelope, as in fixtures/events.
  const results: LineResult[] = lines.flatMap((l) =>
    l.ok
      ? []
      : [
          {
            line: l.line,
            status: "rejected" as const,
            error: { code: "invalid_envelope" as const, message: `Not valid JSON: ${l.error}` },
          },
        ],
  );
  const valid: { line: number; value: unknown }[] = [];
  for (const l of lines) {
    if (!l.ok) continue;
    // An event that would not fit even a request of its own gets 413 and would stop the whole
    // file, so it is rejected here. Larger-than-budget events that do fit go alone in a batch.
    if (Buffer.byteLength(JSON.stringify({ events: [l.value] })) > MAX_BATCH_BYTES) {
      results.push({
        line: l.line,
        status: "rejected",
        error: {
          code: "event_too_large",
          message: `A request holding only this event is over ${MAX_BATCH_BYTES} bytes, the engine's limit`,
        },
      });
    } else valid.push({ line: l.line, value: l.value });
  }
  const client = valid.length === 0 ? undefined : context.client();
  for (const batch of batches(valid, BATCH_EVENTS, BATCH_BYTES)) {
    const response = await client?.json<EventBatchResponse>("POST", "/v1/events/batch", {
      events: batch.map((b) => b.value),
    });
    response?.results.forEach((result, i) => {
      results.push({ line: batch[i]?.line ?? 0, ...result });
    });
  }
  results.sort((a, b) => a.line - b.line);
  const counts = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0 };
  for (const r of results) counts[r.status] += 1;
  if (context.json) {
    printJson(io, { file: path, ...counts, results });
  } else {
    io.stdout(
      `accepted ${counts.accepted} / duplicate ${counts.duplicate} / conflict ${counts.conflict} / rejected ${counts.rejected}\n`,
    );
    for (const r of results) {
      if (r.status === "rejected") {
        const where = "path" in r.error && r.error.path !== undefined ? ` at ${r.error.path}` : "";
        io.stdout(`line ${r.line}: ${r.error.code}${where} - ${r.error.message}\n`);
      } else if (r.status === "conflict") {
        io.stdout(`line ${r.line}: conflict with event ${r.existingEventId}\n`);
      }
    }
  }
  return counts.rejected + counts.conflict > 0 ? EXIT.rejected : EXIT.ok;
}

async function follow(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    { project: { type: "string" }, after: { type: "string" } },
    FOLLOW,
  );
  const projectId = required(values, "project", FOLLOW);
  const client = context.client();
  const say = (text: string) => (context.json ? io.stderr(text) : io.stdout(text));
  try {
    let after: number;
    if (typeof values.after === "string") {
      if (!/^\d+$/.test(values.after))
        throw new CliError(EXIT.failure, `--after must be a whole number\nUsage: ${FOLLOW}`);
      after = Number(values.after);
      await fetchSnapshot(client, projectId); // exits 2 for an unknown project before streaming
    } else {
      after = (await fetchSnapshot(client, projectId)).cursor;
    }
    say(`Following ${projectId} after cursor ${after}\n`);
    for (;;) {
      const response = await client.send(
        "GET",
        `/v1/projects/${encodeURIComponent(projectId)}/events?after=${after}`,
        undefined,
        "text/event-stream",
      );
      if (response.body === null)
        throw new CliError(EXIT.unreachable, "The engine closed the stream");
      for await (const frame of readSse(response.body)) {
        if (frame.event === "event") {
          const envelope = JSON.parse(frame.data) as StoredEnvelope;
          after = envelope.ingestSequence;
          if (context.json) io.stdout(`${JSON.stringify(envelope)}\n`);
          else
            io.stdout(
              `${envelope.ingestSequence} ${envelope.occurredAt} ${envelope.type}${envelope.agentId === undefined ? "" : ` ${envelope.agentId}`}\n`,
            );
        } else if (frame.event === "resnapshot") {
          const reason = (JSON.parse(frame.data) as { reason?: string }).reason ?? "unknown";
          after = (await fetchSnapshot(client, projectId)).cursor;
          say(`resnapshot (${reason}): resuming from cursor ${after}\n`);
          break;
        }
      }
      // The stream ended (resnapshot or engine closing it): reconnect from the cursor.
    }
  } catch (error) {
    if (isAbort(error) || io.signal?.aborted) return EXIT.ok;
    throw error;
  }
}
