// The retro's numbers, computed from a snapshot. Pure: time comes from `now`.
//
// Definitions (also stated in the report):
// - A ticket is a milestone issue titled `[<KEY>] ...`; gates, decision tickets, and lead status
//   PRs are not tickets.
// - Start is the first commit (earliest author date) of the ticket's PR: the merged one, else the
//   most recently created. End is that PR's merge.
// - The milestone starts at its earliest ticket start. Tickets created by then are planned; later
//   ones were added mid-milestone.
// - Days are UTC calendar days from the milestone start to the last close (or `now` while any
//   ticket is open). Open and in-progress counts are taken at the end of each day (or `now`).
// - CI counts cover workflow runs on ticket branches only. Cancelled runs are not failures.

import { ticketKeyOf } from "./reduce.ts";
import { classifyReview, listsNotRun } from "./review.ts";
import type { PullRecord, Snapshot } from "./types.ts";

export type Size = "S" | "M" | "L";
export const SIZES: readonly Size[] = ["S", "M", "L"];

export type Ticket = {
  key: string;
  number: number;
  title: string;
  lane: string | null;
  size: Size | null;
  state: "done" | "dropped" | "open";
  createdAt: string;
  closedAt: string | null;
  pr: number | null;
  start: string | null;
  end: string | null;
};

export type RetroModel = {
  tickets: Ticket[];
  start: string | null;
  planned: Ticket[];
  added: Ticket[];
  done: Ticket[];
  dropped: Ticket[];
  open: Ticket[];
  days: string[];
  openPerDay: number[];
  idealPerDay: number[];
  inProgressPerDay: number[];
  peakParallel: number;
  /** Most tickets in progress at one instant, and when that was first reached. */
  peakConcurrent: { count: number; at: string | null };
  cycleHours: Record<Size, number | null>;
  reviews: { firstPass: number; oneFix: number; escalated: number; notMeasured: string[] };
  ci: { failures: number; reruns: number; flakes: number };
  notRun: number | null;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ms = (iso: string) => Date.parse(iso);
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const round1 = (n: number) => Math.round(n * 10) / 10;
const compareKeys = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function pickPull(pulls: PullRecord[]): PullRecord | undefined {
  const merged = pulls
    .filter((p) => p.mergedAt !== null)
    .sort((a, b) => ms(b.mergedAt ?? "") - ms(a.mergedAt ?? ""));
  if (merged[0] !== undefined) return merged[0];
  return [...pulls].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
}

const FAILED = new Set(["failure", "timed_out"]);

export function buildModel(snapshot: Snapshot, now: Date): RetroModel {
  const nowMs = now.getTime();
  const pullsByKey = new Map<string, PullRecord[]>();
  for (const pull of snapshot.pulls) {
    const key = ticketKeyOf(pull.title);
    if (key !== null) pullsByKey.set(key, [...(pullsByKey.get(key) ?? []), pull]);
  }

  const tickets: Ticket[] = [];
  for (const issue of snapshot.issues) {
    const key = ticketKeyOf(issue.title);
    if (key === null) continue;
    const pull = pickPull(pullsByKey.get(key) ?? []);
    const board = snapshot.board[String(issue.number)] ?? {};
    const size = SIZES.find((s) => s === board.size) ?? null;
    tickets.push({
      key,
      number: issue.number,
      title: issue.title,
      lane: board.lane ?? null,
      size,
      state:
        issue.state === "open" ? "open" : issue.stateReason === "not_planned" ? "dropped" : "done",
      createdAt: issue.createdAt,
      closedAt: issue.closedAt,
      pr: pull?.number ?? null,
      start: pull?.firstCommitAt ?? null,
      end: pull?.mergedAt ?? null,
    });
  }
  tickets.sort((a, b) => compareKeys(a.key, b.key));

  const starts = tickets.flatMap((t) => (t.start === null ? [] : [ms(t.start)]));
  const startMs = starts.length === 0 ? null : Math.min(...starts);
  const start =
    startMs === null
      ? null
      : (tickets.find((t) => t.start !== null && ms(t.start) === startMs)?.start ?? null);
  const planned = startMs === null ? tickets : tickets.filter((t) => ms(t.createdAt) <= startMs);
  const added = startMs === null ? [] : tickets.filter((t) => ms(t.createdAt) > startMs);

  // Timeline: UTC days from the first start to the last close, or to now while work is open.
  const anyOpen = tickets.some((t) => t.state === "open");
  const closes = tickets
    .flatMap((t) => [t.closedAt, t.end])
    .flatMap((d) => (d === null ? [] : [ms(d)]));
  const endMs = anyOpen || closes.length === 0 ? nowMs : Math.max(...closes);
  const firstDay = Date.parse(`${utcDay(startMs ?? nowMs)}T00:00:00Z`);
  const lastDay = Date.parse(`${utcDay(Math.max(endMs, startMs ?? endMs))}T00:00:00Z`);
  const dayStarts: number[] = [];
  for (let d = firstDay; d <= lastDay; d += DAY) dayStarts.push(d);

  // Work stops at the merge; a ticket closed without one stops at its close; open work runs to now.
  const workEnd = (t: Ticket) => ms(t.end ?? t.closedAt ?? now.toISOString());
  const cutoff = (dayStart: number) => Math.min(dayStart + DAY, Math.max(nowMs, dayStart));
  const openPerDay = dayStarts.map((dayStart) => {
    const at = cutoff(dayStart);
    return tickets.filter(
      (t) => ms(t.createdAt) < at && (t.closedAt === null || ms(t.closedAt) >= at),
    ).length;
  });
  const inProgressPerDay = dayStarts.map((dayStart) => {
    const at = cutoff(dayStart);
    return tickets.filter((t) => t.start !== null && ms(t.start) < at && workEnd(t) >= dayStart)
      .length;
  });
  // Sweep start and end events; at equal times ends go first, so back-to-back work is not overlap.
  const events = tickets
    .filter((t) => t.start !== null)
    .flatMap((t) => [
      { time: ms(t.start ?? ""), delta: 1 },
      { time: workEnd(t), delta: -1 },
    ])
    .sort((a, b) => a.time - b.time || a.delta - b.delta);
  const peakConcurrent = { count: 0, at: null as string | null };
  let running = 0;
  for (const event of events) {
    running += event.delta;
    if (running > peakConcurrent.count) {
      peakConcurrent.count = running;
      peakConcurrent.at = new Date(event.time).toISOString();
    }
  }

  const total = tickets.length;
  const idealPerDay = dayStarts.map((_, i) =>
    dayStarts.length === 1 ? total : round1(total * (1 - i / (dayStarts.length - 1))),
  );

  const cycleHours = {} as Record<Size, number | null>;
  for (const size of SIZES) {
    const hours = tickets
      .filter((t) => t.state === "done" && t.size === size && t.start !== null && t.end !== null)
      .map((t) => (ms(t.end ?? "") - ms(t.start ?? "")) / HOUR);
    cycleHours[size] =
      hours.length === 0 ? null : round1(hours.reduce((a, b) => a + b, 0) / hours.length);
  }

  const done = tickets.filter((t) => t.state === "done");
  const reviews = { firstPass: 0, oneFix: 0, escalated: 0, notMeasured: [] as string[] };
  for (const ticket of done) {
    const outcome = classifyReview(snapshot.taskReports[ticket.key]);
    if (outcome === "first_pass") reviews.firstPass += 1;
    else if (outcome === "one_fix") reviews.oneFix += 1;
    else if (outcome === "escalated") reviews.escalated += 1;
    else reviews.notMeasured.push(ticket.key);
  }

  const notRunValues = done
    .map((t) => listsNotRun(snapshot.taskReports[t.key]))
    .filter((v) => v !== null);
  const notRun = notRunValues.length === 0 ? null : notRunValues.filter(Boolean).length;

  const ticketBranches = new Set(tickets.map((t) => t.key));
  for (const [, pulls] of pullsByKey) for (const p of pulls) ticketBranches.add(p.headRef);
  const ci = { failures: 0, reruns: 0, flakes: 0 };
  for (const run of snapshot.runs) {
    if (!ticketBranches.has(run.headBranch)) continue;
    const earlierFailed = run.earlierAttempts.filter((c) => c !== null && FAILED.has(c)).length;
    ci.failures += earlierFailed + (run.conclusion !== null && FAILED.has(run.conclusion) ? 1 : 0);
    ci.reruns += Math.max(0, run.runAttempt - 1);
    if (run.conclusion === "success" && earlierFailed > 0) ci.flakes += 1;
  }

  return {
    tickets,
    start,
    planned,
    added,
    done,
    dropped: tickets.filter((t) => t.state === "dropped"),
    open: tickets.filter((t) => t.state === "open"),
    days: dayStarts.map(utcDay),
    openPerDay,
    idealPerDay,
    inProgressPerDay,
    peakParallel: Math.max(0, ...inProgressPerDay),
    peakConcurrent,
    cycleHours,
    reviews,
    ci,
    notRun,
  };
}
