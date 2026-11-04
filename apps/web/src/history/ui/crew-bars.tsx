import type { StoredEnvelope } from "../../data/domain.ts";
import styles from "./crew-bars.module.css";

export interface CrewRun {
  agentId: string;
  parentId: string;
  name: string;
  startSequence: number;
  startedAt: number;
  finishedSequence?: number;
  finishedAt?: number;
  /** The source guessed the parent link; the label says so. */
  heuristic?: boolean;
}

const ROW = 12;
const MIN_WIDTH = 2;

/** Subagent runs from recorded events: first registration opens, `agent.finished` closes. */
export function crewRuns(events: readonly StoredEnvelope[]): CrewRun[] {
  // A child may register, and even finish, before a later registration links its parent.
  const seen = new Map<
    string,
    Omit<CrewRun, "parentId" | "heuristic"> & {
      parentId: string | undefined;
      heuristic: boolean | undefined;
    }
  >();
  for (const event of events) {
    if (!event.agentId) continue;
    const time = Date.parse(event.receivedAt);
    if (event.type === "agent.registered") {
      if (event.payload.kind !== "subagent") continue;
      const before = seen.get(event.agentId);
      const linked = event.payload.parentAgentId;
      // Only a registration that itself names the parent confirms or clears the guess.
      const heuristic = linked ? event.payload.heuristic === true : before?.heuristic;
      seen.set(event.agentId, {
        ...before,
        agentId: event.agentId,
        parentId: linked ?? before?.parentId,
        name: event.payload.displayName,
        startSequence: before?.startSequence ?? event.ingestSequence,
        startedAt: before?.startedAt ?? time,
        heuristic: heuristic || undefined,
      });
    } else if (event.type === "agent.finished") {
      const run = seen.get(event.agentId);
      if (run && run.finishedSequence === undefined) {
        run.finishedSequence = event.ingestSequence;
        run.finishedAt = time;
      }
    }
  }
  const runs: CrewRun[] = [];
  for (const { parentId, heuristic, ...run } of seen.values()) {
    if (parentId) runs.push({ ...run, parentId, ...(heuristic ? { heuristic } : {}) });
  }
  return runs;
}

export function CrewBars({
  runs,
  parentId,
  range,
}: {
  runs: readonly CrewRun[];
  parentId: string;
  range: { first: number; last: number };
}) {
  const own = runs.filter((run) => run.parentId === parentId);
  if (!own.length) return null;
  const span = Math.max(1, range.last - range.first);
  const place = (sequence: number) =>
    Math.min(100, Math.max(0, ((sequence - range.first) / span) * 100));
  return (
    // biome-ignore lint/a11y/useSemanticElements: the test pins role="group"; a fieldset would bring form semantics to a non-form.
    <div
      className={styles.crew}
      role="group"
      aria-label="Subagent runs"
      style={{ height: own.length * ROW }}
    >
      {own.map((run, row) => {
        const left = place(run.startSequence);
        const right = run.finishedSequence === undefined ? 100 : place(run.finishedSequence);
        const when = new Date(run.startedAt).toLocaleString();
        const label = run.heuristic ? `${run.name} (possibly)` : run.name;
        const tail =
          run.finishedAt === undefined
            ? "running"
            : run.finishedAt < run.startedAt
              ? "duration unknown"
              : `ran ${Math.round((run.finishedAt - run.startedAt) / 1000)}s`;
        return (
          <div
            key={run.agentId}
            className={styles.bar}
            role="img"
            data-heuristic={run.heuristic ? "true" : undefined}
            data-state={run.finishedSequence === undefined ? "running" : "finished"}
            aria-label={`${label} · ${when} · ${tail}`}
            style={{
              left: `min(${left}%, calc(100% - ${MIN_WIDTH}px))`,
              width: `max(${MIN_WIDTH}px, ${right - left}%)`,
              top: row * ROW,
            }}
          />
        );
      })}
    </div>
  );
}
