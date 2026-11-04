import {
  applyRegistration,
  initialEntities,
} from "../../../../../packages/domain/src/reducer/index.ts";
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
  /** Always absent: a heuristic registration never forms or changes a run. */
  heuristic?: never;
}

const ROW = 12;
const MIN_WIDTH = 2;

/**
 * Subagent runs from recorded events. Links, names and kinds come from the domain's own
 * registration rule (`applyRegistration`), so a heuristic registration never creates, moves or
 * renames a run. A run opens at the agent's first recorded registration and closes at its first
 * `agent.finished`, which may arrive before any registration.
 */
export function crewRuns(events: readonly StoredEnvelope[]): CrewRun[] {
  let entities = initialEntities();
  const opened = new Map<string, { sequence: number; at: number }>();
  const closed = new Map<string, { sequence: number; at: number }>();
  for (const event of events) {
    const agentId = event.agentId;
    if (!agentId) continue;
    const mark = { sequence: event.ingestSequence, at: Date.parse(event.receivedAt) };
    if (event.type === "agent.registered") {
      entities = applyRegistration(entities, event, agentId);
      const seq = entities.agents[agentId]?.registeredSeq;
      if (seq === event.ingestSequence && !opened.has(agentId)) opened.set(agentId, mark);
    } else if (event.type === "agent.finished" && !closed.has(agentId)) {
      closed.set(agentId, mark);
    }
  }
  const runs: CrewRun[] = [];
  for (const [agentId, open] of opened) {
    const agent = entities.agents[agentId];
    if (agent?.kind !== "subagent" || agent.parentAgentId === undefined) continue;
    const close = closed.get(agentId);
    // A finish recorded before the first registration also bounds the start.
    const start = close && close.sequence < open.sequence ? close : open;
    runs.push({
      agentId,
      parentId: agent.parentAgentId,
      name: agent.displayName ?? agentId,
      startSequence: start.sequence,
      startedAt: start.at,
      ...(close ? { finishedSequence: close.sequence, finishedAt: close.at } : {}),
    });
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
        const when = Number.isFinite(run.startedAt)
          ? new Date(run.startedAt).toLocaleString()
          : "start time unknown";
        const took = (run.finishedAt ?? Number.NaN) - run.startedAt;
        const tail =
          run.finishedAt === undefined
            ? "running"
            : Number.isFinite(took) && took >= 0
              ? `ran ${Math.round(took / 1000)}s`
              : "duration unknown";
        return (
          <div
            key={run.agentId}
            className={styles.bar}
            role="img"
            data-state={run.finishedSequence === undefined ? "running" : "finished"}
            aria-label={`${run.name} · ${when} · ${tail}`}
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
