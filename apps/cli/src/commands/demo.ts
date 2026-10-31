import {
  DemoIngestError,
  type Pace,
  parseDuration,
  parsePace,
  runOffline,
  runProducer,
} from "@taskville/demo";
import type { EventBatchRequest, EventBatchResponse } from "@taskville/protocol";
import { isAbort } from "../client.ts";
import { type Io, parseCommand, printJson, required, type Values } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";

const RUN =
  "taskville demo run --seed <n> --duration <sim-time> --offline [--pace <pace>] [--json]";
const START =
  "taskville demo start --project <id> --seed <n> [--pace <pace>] [--speed <x>] [--duration <sim-time>]";
const PACE = { pace: { type: "string" } } as const;

/** `taskville demo run` and `demo start` (contracts/cli.md, FR-013), on the M1.15 producer. */
export async function demo(io: Io, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "run") return run(io, rest);
  if (sub === "start") return start(io, rest);
  throw new CliError(EXIT.failure, `Unknown demo command\nUsage: ${RUN}\n       ${START}`);
}

function seedOf(values: Values, usage: string): number {
  const text = required(values, "seed", usage);
  const seed = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(seed)) {
    throw new CliError(EXIT.failure, `--seed must be a whole number\nUsage: ${usage}`);
  }
  return seed;
}

function paceOf(values: Values, usage: string): Pace {
  let pace: Pace;
  try {
    pace = parsePace(typeof values.pace === "string" ? values.pace : "calm");
  } catch (error) {
    throw new CliError(EXIT.failure, `${(error as Error).message}\nUsage: ${usage}`);
  }
  // A custom interval with hundreds of digits parses to Infinity, and the virtual clock would
  // never advance; every interval must be a finite number of milliseconds.
  if (![pace.changeMinMs, pace.changeMaxMs, pace.needsYouMs].every(Number.isSafeInteger)) {
    throw new CliError(
      EXIT.failure,
      `Invalid pace "${pace.name}": intervals must be finite\nUsage: ${usage}`,
    );
  }
  return pace;
}

/** A simulated duration above zero that a run can actually reach (a huge number parses to Infinity). */
function durationOf(text: string, usage: string): number {
  let ms: number;
  try {
    ms = parseDuration(text);
  } catch (error) {
    throw new CliError(EXIT.failure, `--duration: ${(error as Error).message}\nUsage: ${usage}`);
  }
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new CliError(
      EXIT.failure,
      `--duration must be above zero and finite, for example 10m or 2h\nUsage: ${usage}`,
    );
  }
  return ms;
}

/** Runs the scenario through the reducer in process, without an engine, and prints its stateHash. */
async function run(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    {
      seed: { type: "string" },
      duration: { type: "string" },
      offline: { type: "boolean" },
      ...PACE,
    },
    RUN,
  );
  if (values.offline !== true) {
    throw new CliError(
      EXIT.failure,
      `demo run needs --offline (demo start posts to an engine)\nUsage: ${RUN}`,
    );
  }
  const seed = seedOf(values, RUN);
  const pace = paceOf(values, RUN);
  const durationMs = durationOf(required(values, "duration", RUN), RUN);
  const result = runOffline({ seed, pace, durationMs });
  if (context.json) {
    printJson(io, {
      seed,
      pace: pace.name,
      durationMs,
      events: result.events.length,
      stateHash: result.stateHash,
    });
  } else {
    io.stdout(
      `seed ${seed} · pace ${pace.name} · ${values.duration} simulated · ${result.events.length} events\n`,
    );
    io.stdout(`stateHash ${result.stateHash}\n`);
  }
  return EXIT.ok;
}

/** Waits `ms`, or less if the run is interrupted. */
function sleeper(signal: AbortSignal | undefined) {
  return (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
}

/** Runs the seeded producer against the engine on the real clock, `--speed` times faster. */
async function start(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    {
      project: { type: "string" },
      seed: { type: "string" },
      speed: { type: "string" },
      duration: { type: "string" },
      ...PACE,
    },
    START,
  );
  const projectId = required(values, "project", START);
  const seed = seedOf(values, START);
  const pace = paceOf(values, START);
  const speed = typeof values.speed === "string" ? Number(values.speed) : 1;
  if (
    typeof values.speed === "string" &&
    (!/^\d+(\.\d+)?$/.test(values.speed) || !Number.isFinite(speed) || !(speed > 0))
  ) {
    throw new CliError(EXIT.failure, `--speed must be a finite number above zero\nUsage: ${START}`);
  }
  const durationMs =
    typeof values.duration === "string" ? durationOf(values.duration, START) : undefined;
  const client = context.client();
  const say = (text: string) => (context.json ? io.stderr(text) : io.stdout(text));
  say(
    `Demo seed ${seed} (${pace.name}) into ${projectId} at ${speed}x${durationMs === undefined ? "" : ` for ${values.duration} simulated`}; Ctrl+C to stop\n`,
  );
  const options = {
    seed,
    pace,
    projectId,
    speed,
    startAtMs: Date.now(),
    now: Date.now,
    sleep: sleeper(io.signal),
    stop: () => io.signal?.aborted === true,
    post: (batch: EventBatchRequest) =>
      client.json<EventBatchResponse>("POST", "/v1/events/batch", batch),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  try {
    const summary = await runProducer(options);
    report(io, context.json, summary);
    return EXIT.ok;
  } catch (error) {
    if (isAbort(error) || io.signal?.aborted) return EXIT.ok;
    if (error instanceof DemoIngestError) {
      if (error.codes.includes("unknown_project")) {
        throw new CliError(
          EXIT.notFound,
          `Unknown project "${projectId}"; add it with \`taskville project add\``,
        );
      }
      throw new CliError(
        EXIT.failure,
        `The engine did not accept demo events: ${error.codes.join(", ")}`,
      );
    }
    throw error;
  }
}

function report(
  io: Io,
  json: boolean,
  summary: { steps: number; events: number; accepted: number; duplicate: number },
): void {
  if (json) printJson(io, summary);
  else {
    io.stdout(
      `steps ${summary.steps} · events ${summary.events} · accepted ${summary.accepted} / duplicate ${summary.duplicate}\n`,
    );
  }
}
