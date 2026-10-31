// Renders docs/retros/TEMPLATE.md from a snapshot. Anything the data cannot support is printed as
// "not measured", never estimated; chart notes say which values those are.

import { buildModel, type RetroModel, SIZES, type Ticket } from "./model.ts";
import { milestoneKeyOf } from "./reduce.ts";
import { mergeWrittenSections } from "./sections.ts";
import { renderTemplate, type View } from "./template.ts";
import type { Snapshot } from "./types.ts";

export const NOT_MEASURED = "not measured";

export type RenderInput = {
  snapshot: Snapshot;
  template: string;
  now: Date;
  /** Milestone key, e.g. `M1`; must match the snapshot's milestone. */
  key: string;
  /** The earlier report, whose written sections are kept. */
  existing?: string | undefined;
};

/** `2026-10-31T01:38:57Z` -> `2026-10-31T01:38` (UTC, the gantt dateFormat). */
const minute = (iso: string) => new Date(iso).toISOString().slice(0, 16);
const keys = (tickets: Ticket[]) => tickets.map((t) => t.key).join(", ");

/** A gantt task name: no `:`, `;`, or `#` (Mermaid syntax), at most 40 characters. */
export function shortTitle(title: string): string {
  const clean = title
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/[:;#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= 40) return clean;
  const cut = clean.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).trim();
}

function timeline(model: RetroModel, now: Date) {
  const shown = model.tickets.filter(
    (t) => t.start !== null && (t.end !== null || t.state === "open" || t.closedAt !== null),
  );
  const lanes = [...new Set(shown.map((t) => t.lane ?? "No lane"))].sort((a, b) =>
    a === "No lane" ? 1 : b === "No lane" ? -1 : a.localeCompare(b),
  );
  const view = lanes.map((lane) => ({
    lane,
    tickets: shown
      .filter((t) => (t.lane ?? "No lane") === lane)
      .sort(
        (a, b) =>
          Date.parse(a.start ?? "") - Date.parse(b.start ?? "") || a.key.localeCompare(b.key),
      )
      .map((t) => ({
        key: t.key,
        short_title: shortTitle(t.title),
        status_tag: t.end !== null ? "done," : t.state === "open" ? "active," : "",
        start: minute(t.start ?? ""),
        end: minute(t.end ?? (t.state === "open" ? now.toISOString() : (t.closedAt ?? ""))),
      })),
  }));
  const notStarted = model.tickets.filter((t) => t.start === null && t.state === "open");
  const noMerge = model.tickets.filter(
    (t) => t.state === "done" && (t.start === null || t.end === null),
  );
  const note = [
    "Times are UTC. Start is the first commit on the ticket's branch, end the merge; tickets in progress run to the generation time.",
    notStarted.length > 0 ? `Not started: ${keys(notStarted)}.` : "",
    noMerge.length > 0 ? `Closed without a merged PR (not drawn): ${keys(noMerge)}.` : "",
  ];
  return { lanes: view, timeline_note: note.filter(Boolean).join(" ") };
}

function planVersusActual(model: RetroModel): string {
  const row = (label: string, tickets: Ticket[]) =>
    `| ${label} | ${tickets.length} | ${keys(tickets)} |`;
  return [
    "| | Tickets | Keys |",
    "| --- | --- | --- |",
    row("Planned", model.planned),
    row("Added mid-milestone", model.added),
    `| Split | ${NOT_MEASURED} | |`,
    row("Dropped", model.dropped),
    row("Done", model.done),
    row("Still open", model.open),
    "",
    model.start === null
      ? "No ticket has a commit yet, so every ticket counts as planned."
      : `Planned tickets were created by the first commit of the milestone (${minute(model.start)} UTC); added ones after it. Splits are not recorded in GitHub data. Dropped means closed as not planned.`,
  ].join("\n");
}

export function buildView(model: RetroModel, snapshot: Snapshot, now: Date, key: string): View {
  const reviewed = model.reviews.firstPass + model.reviews.oneFix + model.reviews.escalated;
  const unmeasuredSizes = SIZES.filter((s) => model.cycleHours[s] === null);
  const cycle = SIZES.map((s) => model.cycleHours[s] ?? 0);
  return {
    milestone: snapshot.milestone.title,
    key,
    generated_at: `${minute(now.toISOString())}Z`,
    planned: model.planned.length,
    added: model.added.length,
    done: model.done.length,
    dropped: model.dropped.length,
    days: model.start === null ? NOT_MEASURED : model.days.length,
    peak_parallel: model.peakParallel,
    first_pass_pct:
      reviewed === 0 ? NOT_MEASURED : `${Math.round((100 * model.reviews.firstPass) / reviewed)}%`,
    flakes: model.ci.flakes,
    not_run: model.notRun ?? NOT_MEASURED,
    ...timeline(model, now),
    day_labels: model.days.map((d) => `"${d.slice(5)}"`).join(", "),
    planned_plus_added: Math.max(1, model.tickets.length),
    open_per_day: model.openPerDay.join(", "),
    ideal_per_day: model.idealPerDay.join(", "),
    in_progress_per_day: model.inProgressPerDay.join(", "),
    parallel_axis_max: Math.max(1, model.peakParallel),
    parallel_note:
      model.peakConcurrent.at === null
        ? "No ticket has started."
        : `Most in progress at one moment: ${model.peakConcurrent.count} (${minute(model.peakConcurrent.at)} UTC).`,
    max_cycle_hours: Math.max(1, Math.ceil(Math.max(...cycle))),
    cycle_s: cycle[0] ?? 0,
    cycle_m: cycle[1] ?? 0,
    cycle_l: cycle[2] ?? 0,
    cycle_note: [
      "Average over merged tickets with a size on the board.",
      unmeasuredSizes.length > 0
        ? `Not measured: ${unmeasuredSizes.map((s) => `${s} (no merged ${s} tickets)`).join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    first_pass: model.reviews.firstPass,
    one_fix: model.reviews.oneFix,
    escalated: model.reviews.escalated,
    review_note: [
      "From the roborev field of each merged ticket's task report: a medium or higher finding fixed before merge is one fix round.",
      model.reviews.notMeasured.length > 0
        ? `Not measured: ${model.reviews.notMeasured.join(", ")} (the report does not say).`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    ci_failures: model.ci.failures,
    reruns: model.ci.reruns,
    sec_high: NOT_MEASURED,
    sec_med: NOT_MEASURED,
    sec_low: NOT_MEASURED,
    plan_vs_actual_table: planVersusActual(model),
  };
}

export function renderRetro({ snapshot, template, now, key, existing }: RenderInput): string {
  if (milestoneKeyOf(snapshot.milestone.title) !== key) {
    throw new Error(`Snapshot is for milestone "${snapshot.milestone.title}", not ${key}`);
  }
  const model = buildModel(snapshot, now);
  const generated = renderTemplate(template, buildView(model, snapshot, now, key));
  return mergeWrittenSections(generated, existing);
}
