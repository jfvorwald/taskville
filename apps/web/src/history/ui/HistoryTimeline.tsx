import { useMemo, useState } from "react";
import { useHistoryPresentation } from "./HistoryProvider.tsx";
import styles from "./history.module.css";

/** Filtering changes displayed facts and step targets, never the replayed project. */
export function HistoryTimeline() {
  const history = useHistoryPresentation();
  const [agentId, setAgentId] = useState("");
  const selected = history.agents.some((agent) => agent.id === agentId) ? agentId : "";
  const moments = useMemo(
    () => history.moments.filter((moment) => !selected || moment.agentId === selected),
    [history.moments, selected],
  );
  const sequence = history.sequence ?? 0;
  const previous = moments.findLast((moment) => moment.sequence < sequence);
  const next = moments.find((moment) => moment.sequence > sequence);
  const names = new Map(history.agents.map((agent) => [agent.id, agent.name]));
  const first = history.range?.first ?? 1;
  const span = Math.max(1, (history.range?.last ?? first) - first);
  const days = new Map<string, number>();
  for (const moment of history.moments) {
    const day = new Date(moment.time).toLocaleDateString();
    if (!days.has(day)) days.set(day, moment.sequence);
  }
  // Fixed bins along ingest order keep equal or regressing receipt clocks reachable.
  const bins = Array<number>(Math.min(64, Math.max(1, history.moments.length)))
    .fill(0)
    .map((_, position) => ({ sequence: first + position, count: 0 }));
  for (const moment of moments) {
    const bin = Math.min(
      bins.length - 1,
      Math.floor(((moment.sequence - first) / span) * bins.length),
    );
    bins[bin].count += 1;
  }
  const peak = Math.max(1, ...bins.map((bin) => bin.count));
  return (
    <>
      <div className={styles.recording}>
        <div className={styles.days}>
          {[...days].map(([day]) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <svg
          className={styles.density}
          viewBox="0 0 128 24"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Event density: ${moments.length} recorded events, in ingest order`}
        >
          {bins.map(({ sequence: binSequence, count }, index) => (
            <rect
              key={binSequence}
              x={(index * 128) / bins.length}
              y={24 - (count / peak) * 24}
              width={128 / bins.length}
              height={(count / peak) * 24}
            />
          ))}
        </svg>
        <div className={styles.markers}>
          {moments
            .filter((moment) => moment.marker)
            .map((moment) => {
              const label = `${moment.marker} · ${new Date(moment.time).toLocaleString()}${moment.agentId ? ` · ${names.get(moment.agentId) ?? moment.agentId}` : ""}`;
              return (
                <button
                  key={moment.sequence}
                  type="button"
                  data-marker={moment.marker}
                  aria-label={label}
                  title={label}
                  aria-pressed={sequence === moment.sequence}
                  onClick={() => history.seek(moment.sequence)}
                >
                  {moment.marker === "Commit" ? "●" : moment.marker === "Needs you" ? "!" : "✓"}
                </button>
              );
            })}
        </div>
      </div>
      <label htmlFor="history-agent">Agent</label>
      <select
        id="history-agent"
        value={selected}
        onChange={(event) => setAgentId(event.currentTarget.value)}
      >
        <option value="">All agents</option>
        {history.agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!previous}
        onClick={() => previous && history.seek(previous.sequence)}
      >
        Previous moment
      </button>
      <button type="button" disabled={!next} onClick={() => next && history.seek(next.sequence)}>
        Next moment
      </button>
    </>
  );
}
