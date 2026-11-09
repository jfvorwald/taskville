import { useMemo, useState } from "react";
import { compressedGaps, GAP_PLAYBACK_MS, GIT_GLYPH } from "../archives/archive-timelines.ts";
import { CrewBars } from "./crew-bars.tsx";
import { type RecordedMoment, useHistoryPresentation } from "./HistoryProvider.tsx";
import styles from "./history.module.css";

/** The strip never draws more than this many markers or gaps, however long the recording. */
const MAX_MARKERS = 200;
const MAX_GAPS = 100;
const MAX_DAYS = 12;
/** When markers are aggregated, the one that stands for a bucket. */
const PRIORITY = [
  "Needs you",
  "Possibly needs you",
  "Task completed",
  "Git merge",
  "Git ref moved",
  "Git commit",
  "Commit",
];

type Marker = NonNullable<RecordedMoment["marker"]>;

const glyph = (marker: Marker) =>
  marker === "Commit"
    ? "●"
    : marker === "Git commit" || marker === "Git ref moved" || marker === "Git merge"
      ? GIT_GLYPH[marker]
      : marker === "Needs you" || marker === "Possibly needs you"
        ? "!"
        : "✓";

/** One marker, or a bucket of neighbours once there are more markers than the strip can hold. */
interface MarkerBucket {
  readonly moments: RecordedMoment[];
  readonly kinds: Map<Marker, number>;
}

function bucketMarkers(markers: readonly RecordedMoment[]): MarkerBucket[] {
  if (markers.length <= MAX_MARKERS)
    return markers.map((moment) => ({
      moments: [moment],
      kinds: new Map<Marker, number>([[moment.marker as Marker, 1]]),
    }));
  const low = markers[0]?.sequence ?? 0;
  const span = (markers.at(-1)?.sequence ?? low) - low + 1;
  const buckets = new Map<number, MarkerBucket>();
  for (const moment of markers) {
    const index = Math.floor(((moment.sequence - low) / span) * MAX_MARKERS);
    const bucket: MarkerBucket = buckets.get(index) ?? { moments: [], kinds: new Map() };
    bucket.moments.push(moment);
    bucket.kinds.set(moment.marker as Marker, (bucket.kinds.get(moment.marker as Marker) ?? 0) + 1);
    buckets.set(index, bucket);
  }
  return [...buckets.values()];
}

/** The first and last day always show; a long recording keeps an even sample between. */
function dayLabels(days: readonly string[]): string[] {
  if (days.length <= MAX_DAYS) return [...days];
  return Array.from(
    { length: MAX_DAYS },
    (_, index) => days[Math.round((index * (days.length - 1)) / (MAX_DAYS - 1))] as string,
  );
}

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
  // At a window boundary an unfiltered view can still step to events that are not loaded yet.
  const bounds = history.range;
  const before =
    !selected && !previous && bounds && sequence > bounds.first ? sequence - 1 : undefined;
  const after =
    !selected && !next && bounds && sequence > 0 && sequence < bounds.last
      ? sequence + 1
      : undefined;
  const names = new Map(history.agents.map((agent) => [agent.id, agent.name]));
  const range = history.range;
  const crew = useMemo(
    () =>
      history.crew.filter(
        (run) => !selected || run.parentId === selected || run.agentId === selected,
      ),
    [history.crew, selected],
  );
  const first = history.range?.first ?? 1;
  const span = Math.max(1, (history.range?.last ?? first) - first);
  // Only a window of a long archive is loaded, so its first and last day come from the timeline.
  const timeline = history.timeline;
  const days = new Set<string>();
  const noteDay = (time: number) => {
    if (Number.isFinite(time)) days.add(new Date(time).toLocaleDateString());
  };
  if (timeline) noteDay(Date.parse(timeline.firstAt));
  for (const moment of history.moments) noteDay(moment.time);
  if (timeline) noteDay(Date.parse(timeline.lastAt));
  const gaps = useMemo(
    () =>
      timeline?.kind === "archive"
        ? compressedGaps(history.moments)
            .sort((a, b) => b.to - b.from - (a.to - a.from))
            .slice(0, MAX_GAPS)
            .sort((a, b) => a.sequence - b.sequence)
        : [],
    [history.moments, timeline?.kind],
  );
  const buckets = useMemo(
    () => bucketMarkers(moments.filter((moment) => moment.marker)),
    [moments],
  );
  const strip = [
    ...buckets.map((bucket) => ({ sequence: bucket.moments[0]?.sequence ?? 0, bucket })),
    ...gaps.map((gap) => ({ sequence: gap.sequence - 0.5, gap })),
  ].sort((a, b) => a.sequence - b.sequence);
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
          {dayLabels([...days]).map((day) => (
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
        {range &&
          [...new Set(crew.map((run) => run.parentId))].map((parentId) => (
            <CrewBars key={parentId} runs={crew} parentId={parentId} range={range} />
          ))}
        <div className={styles.markers}>
          {strip.map((item) => {
            if ("gap" in item) {
              const { gap } = item;
              const label = `Gap of ${Math.round((gap.to - gap.from) / 86_400_000) || "less than 1"} days compressed to ${GAP_PLAYBACK_MS / 1000} seconds · ${new Date(gap.from).toLocaleString()} to ${new Date(gap.to).toLocaleString()}`;
              return (
                <span
                  key={`gap-${gap.sequence}`}
                  role="img"
                  data-gap
                  aria-label={label}
                  title={label}
                >
                  ⋯
                </span>
              );
            }
            const { bucket } = item;
            const [head] = bucket.moments;
            const tail = bucket.moments.at(-1);
            if (!head || !tail) return null;
            const kind =
              bucket.moments.length === 1
                ? (head.marker as Marker)
                : ((PRIORITY.find((name) => bucket.kinds.has(name as Marker)) ??
                    head.marker) as Marker);
            const label =
              bucket.moments.length === 1
                ? `${head.marker} · ${new Date(head.time).toLocaleString()}${head.agentId ? ` · ${names.get(head.agentId) ?? head.agentId}` : ""}`
                : `${bucket.moments.length} markers · ${new Date(head.time).toLocaleString()} to ${new Date(tail.time).toLocaleString()}: ${[...bucket.kinds].map(([name, count]) => `${count} ${name}`).join(", ")}`;
            return (
              <button
                key={head.sequence}
                type="button"
                data-marker={kind}
                aria-label={label}
                title={label}
                aria-pressed={sequence >= head.sequence && sequence <= tail.sequence}
                onClick={() =>
                  // A bucket seeks to the marker it displays, not its first marker.
                  history.seek(
                    (bucket.moments.find((moment) => moment.marker === kind) ?? head).sequence,
                  )
                }
              >
                {glyph(kind)}
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
        disabled={!previous && before === undefined}
        onClick={() => {
          const target = previous?.sequence ?? before;
          if (target !== undefined) history.seek(target);
        }}
      >
        Previous moment
      </button>
      <button
        type="button"
        disabled={!next && after === undefined}
        onClick={() => {
          const target = next?.sequence ?? after;
          if (target !== undefined) history.seek(target);
        }}
      >
        Next moment
      </button>
    </>
  );
}
