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
}

const ROW = 12;

/** Subagent runs from recorded events: first registration opens, `agent.finished` closes. */
export function crewRuns(events: readonly StoredEnvelope[]): CrewRun[] {
  const runs = new Map<string, CrewRun>();
  for (const event of events) {
    if (!event.agentId) continue;
    const time = Date.parse(event.receivedAt);
    if (event.type === "agent.registered") {
      if (event.payload.kind !== "subagent") continue;
      const before = runs.get(event.agentId);
      const parentId = event.payload.parentAgentId ?? before?.parentId;
      if (!parentId) continue;
      runs.set(event.agentId, {
        ...before,
        agentId: event.agentId,
        parentId,
        name: event.payload.displayName,
        startSequence: before?.startSequence ?? event.ingestSequence,
        startedAt: before?.startedAt ?? time,
      });
    } else if (event.type === "agent.finished") {
      const run = runs.get(event.agentId);
      if (run && run.finishedSequence === undefined) {
        run.finishedSequence = event.ingestSequence;
        run.finishedAt = time;
      }
    }
  }
  return [...runs.values()];
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
        const tail =
          run.finishedAt === undefined
            ? "running"
            : `ran ${Math.round((run.finishedAt - run.startedAt) / 1000)}s`;
        return (
          <div
            key={run.agentId}
            className={styles.bar}
            role="img"
            data-state={run.finishedSequence === undefined ? "running" : "finished"}
            aria-label={`${run.name} · ${when} · ${tail}`}
            style={{ left: `${left}%`, width: `${right - left}%`, top: row * ROW }}
          />
        );
      })}
    </div>
  );
}
