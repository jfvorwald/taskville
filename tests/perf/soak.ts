// SC-006: over an 8-hour six-agent demo (1x, or the same event count accelerated), engine
// resident memory grows less than 10% between hour 1 and hour 8. The demo's 8 hours of events
// are posted to a spawned `taskville serve` at an accelerated virtual clock, with a viewer
// streaming the project. At each simulated hour boundary (after every earlier event was
// acknowledged and received by the viewer) the engine's RSS is sampled with `ps` and the
// snapshot's state is sized, so unbounded state (requests and commands are never pruned) shows.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CALM, LIVELY, type Pace, runProducer } from "../../packages/demo/src/index.ts";
import { createProject, sampleRss, startEngine } from "./engine.ts";
import { growth, simulatedHour } from "./stats.ts";
import { connectViewer } from "./viewer.ts";

export const MEMORY_GROWTH_LIMIT = 0.1;
const HOUR_MS = 3_600_000;

export interface HourMark {
  hour: number;
  events: number;
  rssMiB: number;
  stateKiB: number;
  /** Size of `taskville.db-wal` at the mark (#166: is the WAL bounded during the run?). */
  walKiB: number;
  agents: number;
  sessions: number;
  toolCalls: number;
  tasks: number;
  requests: number;
  openRequests: number;
  commands: number;
}

export interface SoakResult {
  pace: string;
  seed: number;
  speed: number;
  hours: number;
  events: number;
  wallSeconds: number;
  effectiveSpeed: number;
  bootRssMiB: number;
  marks: HourMark[];
  growth: number;
  viewerReceived: number;
  viewerAnomalies: number;
  pass: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function soakRun(options: {
  pace: "calm" | "lively";
  seed?: number;
  speed?: number;
  hours?: number;
}): Promise<SoakResult> {
  const pace: Pace = options.pace === "calm" ? CALM : LIVELY;
  const seed = options.seed ?? 42;
  const speed = options.speed ?? 480;
  const hours = options.hours ?? 8;
  const engine = await startEngine();
  try {
    await createProject(engine, "soak");
    const viewer = await connectViewer(engine, "soak", 1);
    const bootRssMiB = (await sampleRss(engine)) / 1024;
    const marks: HourMark[] = [];
    let events = 0;
    let head = 1;

    const mark = async (hour: number) => {
      await viewer.reach(head);
      const rssMiB = (await sampleRss(engine)) / 1024;
      const wal = join(engine.home, "taskville.db-wal");
      const walKiB = existsSync(wal) ? statSync(wal).size / 1024 : 0;
      const snapshot = (await (await engine.get("/v1/projects/soak/snapshot")).json()) as {
        state: Record<string, Record<string, { state?: string }>>;
      };
      const count = (key: string) => Object.keys(snapshot.state[key] ?? {}).length;
      const requests = Object.values(snapshot.state.requests ?? {});
      marks.push({
        hour,
        events,
        rssMiB,
        walKiB,
        stateKiB: JSON.stringify(snapshot.state).length / 1024,
        agents: count("agents"),
        sessions: count("sessions"),
        toolCalls: count("toolCalls"),
        tasks: count("tasks"),
        requests: requests.length,
        openRequests: requests.filter((r) => r.state === "open").length,
        commands: count("commands"),
      });
    };

    const startAtMs = Date.now();
    let nextMark = 1;
    const wallStart = performance.now();
    await runProducer({
      seed,
      pace,
      projectId: "soak",
      startAtMs,
      speed,
      durationMs: hours * HOUR_MS,
      now: () => Date.now(),
      sleep,
      post: async (batch) => {
        const first = batch.events[0] as { occurredAt: string } | undefined;
        const hour = first ? simulatedHour(startAtMs, first.occurredAt) : 0;
        while (nextMark <= hour && nextMark < hours) await mark(nextMark++);
        const response = await engine.ingest(batch.events);
        events += batch.events.length;
        head = Math.max(head, response.heads.soak ?? head);
        return response;
      },
    });
    const wallSeconds = (performance.now() - wallStart) / 1000;
    while (nextMark <= hours) await mark(nextMark++);
    viewer.close();

    const first = marks.find((m) => m.hour === 1);
    const last = marks.find((m) => m.hour === hours);
    if (!first || !last) throw new Error("missing hour marks");
    const change = growth(first.rssMiB, last.rssMiB);
    return {
      pace: options.pace,
      seed,
      speed,
      hours,
      events,
      wallSeconds,
      effectiveSpeed: (hours * 3600) / wallSeconds,
      bootRssMiB,
      marks,
      growth: change,
      viewerReceived: viewer.received,
      viewerAnomalies: viewer.anomalies,
      pass: change < MEMORY_GROWTH_LIMIT && viewer.anomalies === 0 && viewer.received === events,
    };
  } finally {
    await engine.stop();
  }
}
