import { hash32, seededRandom } from "../../quips/hash.ts";
import { QUIP_MAX_AGE_MS } from "../../quips/schedule.ts";
import {
  type AgentBreak,
  type BreakActivity,
  type BreakAgentInput,
  type BreakPlan,
  type BreakPlanInput,
  type BreakSite,
  BUBBLE_TURN_MS,
  type Conversation,
  MAX_ACTIVITY_MS,
  MAX_BREAK_DELAY_MS,
  MIN_ACTIVITY_MS,
  MIN_BREAK_DELAY_MS,
} from "./types.ts";

/** One seeded stretch of one agent's break, before it has a place. */
interface Segment {
  agentId: string;
  startedAt: number;
  endsAt: number;
  /** Seeded draws in [0, 1): the activity pick, and the fallback pick. */
  pick: number;
  alt: number;
}

interface Placed {
  segment: Segment;
  activity: BreakActivity;
  siteId: string | null;
  spot: number;
}

function compareIds(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether the agent may be on break at all, ignoring the clock. */
function eligible(agent: BreakAgentInput): boolean {
  if (agent.level === "needs_you" || agent.level === "trouble") return false;
  if (agent.rest === "working") return false;
  if (agent.rest === "idle" && !agent.liveSession) return false;
  // No waiting record means no seed and no start time, so no break.
  return agent.waitingSince !== null;
}

/**
 * The agent's chain of segments that have started by `now`. The delay and every draw come from
 * one generator seeded by agent ID and waiting event ID, drawn in a fixed order, so the chain is
 * the same at any `now` and whatever else is in the plan.
 */
function segmentsOf(agent: BreakAgentInput, now: number): Segment[] {
  const since = agent.waitingSince as number;
  // Like quips: a state a day old or more shows no break, which bounds the walk.
  if (now - since >= QUIP_MAX_AGE_MS) return [];
  const random = seededRandom(hash32(agent.id, agent.waitingEventId ?? ""));
  const draw = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const out: Segment[] = [];
  let startedAt = since + draw(MIN_BREAK_DELAY_MS, MAX_BREAK_DELAY_MS);
  while (startedAt <= now) {
    const endsAt = startedAt + draw(MIN_ACTIVITY_MS, MAX_ACTIVITY_MS);
    out.push({ agentId: agent.id, startedAt, endsAt, pick: random(), alt: random() });
    startedAt = endsAt;
  }
  return out;
}

function pickFrom<T>(list: readonly T[], u: number): T {
  return list[Math.floor(u * list.length)] as T;
}

/** The lowest spot index not held by an active placement at this place, or null when full. */
function freeSpot(active: readonly Placed[], siteId: string | null, spots: number): number | null {
  const taken = new Set<number>();
  for (const p of active) if (p.siteId === siteId) taken.add(p.spot);
  for (let spot = 0; spot < spots; spot++) if (!taken.has(spot)) return spot;
  return null;
}

/**
 * Places segments in order of start time (ties by agent ID), each against the placements still
 * running when it starts. A segment's place is therefore fixed at its start and cannot change
 * while it runs, whatever the other agents do later.
 */
function placeAll(segments: Segment[], input: BreakPlanInput): Placed[] {
  const sites = [...input.sites].sort((x, y) => compareIds(x.id, y.id));
  const plazaActivities: BreakActivity[] = ["stroll", "juggle", "pigeons"];
  if (input.night) plazaActivities.push("stargaze");
  const sitesOf = (kind: BreakSite["kind"]) => sites.filter((s) => s.kind === kind);
  const options: BreakActivity[] = [...plazaActivities];
  if (sitesOf("bar").length > 0) options.push("bar");
  if (sitesOf("smoke").length > 0) options.push("smoke");

  const ordered = [...segments].sort(
    (x, y) => x.startedAt - y.startedAt || compareIds(x.agentId, y.agentId),
  );
  let active: Placed[] = [];
  const done: Placed[] = [];

  for (const segment of ordered) {
    active = active.filter((p) => p.segment.endsAt > segment.startedAt);
    const place = (
      activity: BreakActivity,
      siteId: string | null,
      spots: number,
    ): Placed | null => {
      const spot = freeSpot(active, siteId, spots);
      return spot === null ? null : { segment, activity, siteId, spot };
    };
    const tryPreferred = (): Placed | null => {
      const activity = pickFrom(options, segment.pick);
      if (activity === "bar" || activity === "smoke") {
        const own = sitesOf(activity);
        const first = Math.floor(segment.alt * own.length);
        for (let i = 0; i < own.length; i++) {
          const site = own[(first + i) % own.length] as BreakSite;
          const found = place(activity, site.id, site.spots);
          if (found) return found;
        }
        return null;
      }
      return place(activity, null, input.plazaSpots);
    };
    const tryFallback = (): Placed | null => {
      // The preferred place is full: another plaza activity, then any site with room.
      const plaza = place(pickFrom(plazaActivities, segment.alt), null, input.plazaSpots);
      if (plaza) return plaza;
      for (const site of sites) {
        const found = place(site.kind, site.id, site.spots);
        if (found) return found;
      }
      return null;
    };
    // When everything is full the agent stays off break for this segment and tries again at the
    // next one; a break is never forced past the spot counts.
    const placed = tryPreferred() ?? tryFallback();
    if (placed) {
      active.push(placed);
      done.push(placed);
    }
  }
  return done;
}

/** Pairs the agents of each place by sorted ID, two at a time; the odd one out stays quiet. */
function pairUp(current: Map<string, AgentBreak>, now: number): Conversation[] {
  const groups = new Map<string | null, string[]>();
  for (const [id, brk] of current) {
    const ids = groups.get(brk.siteId) ?? [];
    ids.push(id);
    groups.set(brk.siteId, ids);
  }
  const out: Conversation[] = [];
  for (const [siteId, ids] of groups) {
    ids.sort(compareIds);
    for (let i = 0; i + 1 < ids.length; i += 2) {
      const a = ids[i] as string;
      const b = ids[i + 1] as string;
      // The pair has been together since the later of the two arrived.
      const pairStart = Math.max(
        (current.get(a) as AgentBreak).startedAt,
        (current.get(b) as AgentBreak).startedAt,
      );
      const turn = Math.floor((now - pairStart) / BUBBLE_TURN_MS);
      out.push({ a, b, siteId, turn, turnStartedAt: pairStart + turn * BUBBLE_TURN_MS });
    }
  }
  return out;
}

/**
 * Who is on break, doing what and where, at `input.now`. Pure: no clock, no random source, and
 * the result does not depend on the order of agents or sites. Presentation only.
 */
export function planBreaks(input: BreakPlanInput): BreakPlan {
  const agents = new Map<string, AgentBreak>();
  if (!input.enabled) return { agents, conversations: [] };

  const segments: Segment[] = [];
  for (const agent of input.agents) {
    if (eligible(agent)) segments.push(...segmentsOf(agent, input.now));
  }
  for (const p of placeAll(segments, input)) {
    const { startedAt, endsAt, agentId } = p.segment;
    if (input.now < endsAt) {
      agents.set(agentId, {
        activity: p.activity,
        siteId: p.siteId,
        spot: p.spot,
        startedAt,
        endsAt,
      });
    }
  }
  return { agents, conversations: pairUp(agents, input.now) };
}
