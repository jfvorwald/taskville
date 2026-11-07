import { describe, expect, it } from "vitest";
import { planBreaks } from "../../../src/city/breaks/plan.ts";
import {
  type AgentBreak,
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
} from "../../../src/city/breaks/types.ts";

const SINCE = 1_000_000;
const SITES: BreakSite[] = [
  { id: "bar", kind: "bar", spots: 3 },
  { id: "smoke", kind: "smoke", spots: 2 },
];

function waiter(id: string, over: Partial<BreakAgentInput> = {}): BreakAgentInput {
  return {
    id,
    rest: "waiting",
    level: "waiting",
    waitingEventId: `evt-${id}`,
    waitingSince: SINCE,
    liveSession: true,
    ...over,
  };
}

function crew(n: number, over: Partial<BreakAgentInput> = {}): BreakAgentInput[] {
  return Array.from({ length: n }, (_, i) => waiter(`agent-${String(i).padStart(2, "0")}`, over));
}

function input(over: Partial<BreakPlanInput> = {}): BreakPlanInput {
  return {
    now: SINCE + MAX_BREAK_DELAY_MS + 1,
    enabled: true,
    night: false,
    sites: SITES,
    plazaSpots: 8,
    agents: crew(1),
    ...over,
  };
}

function planAt(now: number, over: Partial<BreakPlanInput> = {}): BreakPlan {
  return planBreaks(input({ ...over, now }));
}

/** Sample times from `from` to `to` (exclusive) every `step` ms. */
function times(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
}

const HALF_HOUR = 30 * 60_000;

function siteSpots(siteId: string | null, plazaSpots: number, sites: readonly BreakSite[]): number {
  if (siteId === null) return plazaSpots;
  return sites.find((s) => s.id === siteId)?.spots ?? 0;
}

function byA(list: readonly Conversation[]): Conversation[] {
  return [...list].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
}

/** The first whole second (from `since`) at which the agent is on break, or null. */
function firstBreakAt(agent: BreakAgentInput): { at: number; brk: AgentBreak } | null {
  for (const t of times(SINCE, SINCE + 4 * 60_000, 1000)) {
    const brk = planAt(t, { agents: [agent] }).agents.get(agent.id);
    if (brk) return { at: t, brk };
  }
  return null;
}

describe("break planner: eligibility", () => {
  it("plans nothing when break time is disabled", () => {
    const plan = planAt(SINCE + HALF_HOUR, { enabled: false, agents: crew(6) });
    expect(plan.agents.size).toBe(0);
    expect(plan.conversations).toEqual([]);
  });

  it("plans nothing for no agents", () => {
    const plan = planAt(SINCE + HALF_HOUR, { agents: [] });
    expect(plan.agents.size).toBe(0);
    expect(plan.conversations).toEqual([]);
  });

  it("never puts a needs-you agent on break, however long it has waited", () => {
    const agents = crew(4, { rest: "waiting", level: "needs_you" });
    for (const t of times(SINCE, SINCE + HALF_HOUR, 30_000)) {
      expect(planAt(t, { agents }).agents.size).toBe(0);
    }
  });

  it("never puts a trouble agent on break, however long it has waited", () => {
    const agents = crew(4, { rest: "waiting", level: "trouble" });
    for (const t of times(SINCE, SINCE + HALF_HOUR, 30_000)) {
      expect(planAt(t, { agents }).agents.size).toBe(0);
    }
  });

  it("never puts a working agent on break", () => {
    const agents = crew(4, { rest: "working", level: null });
    for (const t of times(SINCE, SINCE + HALF_HOUR, 30_000)) {
      expect(planAt(t, { agents }).agents.size).toBe(0);
    }
  });

  it("keeps a needs-you agent off break even when its rest state says waiting or idle", () => {
    const agents = [
      waiter("a", { rest: "idle", level: "needs_you" }),
      waiter("b", { rest: "waiting", level: "trouble" }),
    ];
    expect(planAt(SINCE + HALF_HOUR, { agents }).agents.size).toBe(0);
  });

  it("does not break an agent that has waited less than the minimum delay", () => {
    const agents = crew(12);
    const plan = planAt(SINCE + MIN_BREAK_DELAY_MS - 1, { agents });
    expect(plan.agents.size).toBe(0);
    expect(plan.conversations).toEqual([]);
  });

  it("breaks every waiting agent once the maximum delay has passed", () => {
    const agents = crew(12);
    const plan = planAt(SINCE + MAX_BREAK_DELAY_MS, { agents });
    expect([...plan.agents.keys()].sort()).toEqual(agents.map((a) => a.id).sort());
  });

  it("starts each break after a seeded 60 to 120 s delay, with startedAt at the end of it", () => {
    const delays = new Set<number>();
    for (const agent of crew(12)) {
      const first = firstBreakAt(agent);
      expect(first, agent.id).not.toBeNull();
      if (!first) continue;
      const delay = first.brk.startedAt - SINCE;
      expect(delay).toBeGreaterThanOrEqual(MIN_BREAK_DELAY_MS);
      expect(delay).toBeLessThanOrEqual(MAX_BREAK_DELAY_MS);
      expect(first.at).toBeGreaterThanOrEqual(first.brk.startedAt);
      delays.add(delay);
    }
    // seeded per agent, not one fixed delay for everyone
    expect(delays.size).toBeGreaterThan(1);
  });

  it("measures the delay from the waiting record, so a later waitingSince starts later", () => {
    const early = firstBreakAt(waiter("solo"));
    const late = firstBreakAt(waiter("solo", { waitingSince: SINCE + 30_000 }));
    // a late record is judged by its own time, not the clock origin
    const lateBreak = planAt(SINCE + 30_000 + MAX_BREAK_DELAY_MS, {
      agents: [waiter("solo", { waitingSince: SINCE + 30_000 })],
    }).agents.get("solo");
    expect(early).not.toBeNull();
    expect(lateBreak).toBeDefined();
    expect(late === null || late.brk.startedAt >= SINCE + 30_000 + MIN_BREAK_DELAY_MS).toBe(true);
  });

  it("treats an idle agent with a live session as eligible", () => {
    const agents = crew(6, { rest: "idle", liveSession: true });
    const plan = planAt(SINCE + MAX_BREAK_DELAY_MS, { agents });
    expect(plan.agents.size).toBe(6);
  });

  it("treats an idle agent without a live session as not eligible", () => {
    const agents = crew(6, { rest: "idle", liveSession: false });
    for (const t of times(SINCE, SINCE + HALF_HOUR, 30_000)) {
      expect(planAt(t, { agents }).agents.size).toBe(0);
    }
  });

  it("ends a break at once when the agent starts working, and only that agent's", () => {
    const agents = crew(4);
    const t = SINCE + MAX_BREAK_DELAY_MS + 10_000;
    expect(planAt(t, { agents }).agents.size).toBe(4);
    const after = agents.map((a) =>
      a.id === "agent-01" ? { ...a, rest: "working" as const, level: null } : a,
    );
    const plan = planAt(t, { agents: after });
    expect(plan.agents.has("agent-01")).toBe(false);
    expect(plan.agents.size).toBe(3);
    for (const c of plan.conversations) {
      expect([c.a, c.b]).not.toContain("agent-01");
    }
  });

  it("ends a break at once when the agent needs the owner", () => {
    const agents = crew(3);
    const t = SINCE + MAX_BREAK_DELAY_MS + 10_000;
    const after = agents.map((a) =>
      a.id === "agent-02" ? { ...a, level: "needs_you" as const } : a,
    );
    const plan = planAt(t, { agents: after });
    expect(plan.agents.has("agent-02")).toBe(false);
    for (const c of plan.conversations) {
      expect([c.a, c.b]).not.toContain("agent-02");
    }
  });
});

describe("break planner: determinism", () => {
  const agents = crew(10);
  const t = SINCE + 7 * 60_000;

  it("gives deep-equal plans for the same input", () => {
    expect(planAt(t, { agents })).toEqual(planAt(t, { agents }));
  });

  it("does not depend on the order of the agents", () => {
    const forward = planAt(t, { agents });
    const reversed = planAt(t, { agents: [...agents].reverse() });
    const rotated = planAt(t, { agents: [...agents.slice(4), ...agents.slice(0, 4)] });
    expect(reversed.agents).toEqual(forward.agents);
    expect(rotated.agents).toEqual(forward.agents);
    expect(byA(reversed.conversations)).toEqual(byA(forward.conversations));
    expect(byA(rotated.conversations)).toEqual(byA(forward.conversations));
  });

  it("does not depend on the order of the sites", () => {
    const forward = planAt(t, { agents });
    const flipped = planAt(t, { agents, sites: [...SITES].reverse() });
    expect(flipped.agents).toEqual(forward.agents);
  });

  it("is a function of its inputs alone: replay at T equals the live plan at T", () => {
    const live = planAt(t, { agents });
    // a "replay" visits other moments first, in any order, then asks for T
    for (const other of [t + 90_000, SINCE, t - 45_000, t + 1_000_000, t + 1]) {
      planAt(other, { agents });
    }
    const replay = planAt(t, { agents: [...agents].reverse() });
    expect(replay.agents).toEqual(live.agents);
    expect(byA(replay.conversations)).toEqual(byA(live.conversations));
  });

  it("does not mutate its input", () => {
    const frozen = input({ now: t, agents: agents.map((a) => Object.freeze({ ...a })) });
    Object.freeze(frozen.agents);
    Object.freeze(frozen.sites);
    expect(() => planBreaks(frozen)).not.toThrow();
  });

  it("seeds from the agent and waiting event IDs: another event gives another plan", () => {
    const base = planAt(t, { agents });
    const other = planAt(t, {
      agents: agents.map((a) => ({ ...a, waitingEventId: `other-${a.id}` })),
    });
    const differs = agents.some(
      (a) => JSON.stringify(base.agents.get(a.id)) !== JSON.stringify(other.agents.get(a.id)),
    );
    expect(differs).toBe(true);
  });

  it("is independent of an agent's neighbours for timing (adding agents keeps start times)", () => {
    const solo = firstBreakAt(agents[0] as BreakAgentInput);
    expect(solo).not.toBeNull();
    const crowded = planAt(solo?.at ?? 0, { agents }).agents.get((agents[0] as BreakAgentInput).id);
    expect(crowded?.startedAt).toBe(solo?.brk.startedAt);
  });
});

describe("break planner: activity timing", () => {
  const agents = crew(6);

  it("keeps startedAt <= now < endsAt, with each activity lasting 2 to 5 minutes", () => {
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 5000)) {
      for (const brk of planAt(t, { agents }).agents.values()) {
        expect(brk.startedAt).toBeLessThanOrEqual(t);
        expect(brk.endsAt).toBeGreaterThan(t);
        expect(brk.endsAt - brk.startedAt).toBeGreaterThanOrEqual(MIN_ACTIVITY_MS);
        expect(brk.endsAt - brk.startedAt).toBeLessThanOrEqual(MAX_ACTIVITY_MS);
      }
    }
  });

  it("changes activity, site and spot only at the seeded boundary", () => {
    for (const agent of agents) {
      const seen = new Map<number, AgentBreak>();
      for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 5000)) {
        const brk = planAt(t, { agents }).agents.get(agent.id);
        expect(brk, `${agent.id} at ${t}`).toBeDefined();
        if (!brk) continue;
        const prior = seen.get(brk.startedAt);
        if (prior) expect(brk).toEqual(prior);
        else seen.set(brk.startedAt, brk);
      }
      expect(seen.size).toBeGreaterThan(1);
    }
  });

  it("chains activities with no gap: each one starts when the last ends", () => {
    for (const agent of agents) {
      const segments = new Map<number, AgentBreak>();
      for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 5000)) {
        const brk = planAt(t, { agents }).agents.get(agent.id);
        if (brk) segments.set(brk.startedAt, brk);
      }
      const ordered = [...segments.values()].sort((x, y) => x.startedAt - y.startedAt);
      for (let i = 1; i < ordered.length; i++) {
        expect((ordered[i] as AgentBreak).startedAt).toBe((ordered[i - 1] as AgentBreak).endsAt);
      }
    }
  });

  it("offers stargazing only at night", () => {
    const many = crew(40);
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 20_000)) {
      for (const brk of planAt(t, { agents: many, night: false }).agents.values()) {
        expect(brk.activity).not.toBe("stargaze");
      }
    }
  });

  it("does stargaze at night, in the plaza", () => {
    const many = crew(40);
    const found: AgentBreak[] = [];
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 20_000)) {
      for (const brk of planAt(t, { agents: many, night: true }).agents.values()) {
        if (brk.activity === "stargaze") found.push(brk);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const brk of found) expect(brk.siteId).toBeNull();
  });

  it("judges night at a segment's start: a day segment stays a day activity after dusk", () => {
    const many = crew(40);
    let checked = 0;
    for (const agent of many) {
      const day = firstBreakAt(agent);
      if (!day) continue;
      const { startedAt, endsAt } = day.brk;
      const dusk = startedAt + Math.floor((endsAt - startedAt) / 2);
      for (const t of times(dusk, endsAt, 1000)) {
        const brk = planAt(t, { agents: [agent], night: (ms) => ms >= dusk }).agents.get(agent.id);
        expect(brk, `${agent.id} at ${t}`).toEqual(day.brk);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("offers stargazing to segments that start at or after dusk, and not before", () => {
    const many = crew(40);
    const dusk = SINCE + 10 * 60_000;
    const night = (ms: number) => ms >= dusk;
    const late = new Set<string>();
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 5000)) {
      for (const [id, brk] of planAt(t, { agents: many, night }).agents) {
        if (brk.activity !== "stargaze") continue;
        expect(brk.startedAt, `${id} at ${t}`).toBeGreaterThanOrEqual(dusk);
        expect(brk.siteId).toBeNull();
        late.add(`${id}@${brk.startedAt}`);
      }
    }
    expect(late.size).toBeGreaterThan(0);
  });

  it("judges night at a segment's start: a stargaze segment runs on after dawn", () => {
    let checked = 0;
    for (const agent of crew(40)) {
      let star: AgentBreak | null = null;
      for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 5000)) {
        const brk = planAt(t, { agents: [agent], night: true }).agents.get(agent.id);
        if (brk && brk.activity === "stargaze") {
          star = brk;
          break;
        }
      }
      if (!star) continue;
      const dawn = star.startedAt + Math.floor((star.endsAt - star.startedAt) / 2);
      for (const t of times(dawn, star.endsAt, 1000)) {
        const brk = planAt(t, { agents: [agent], night: (ms) => ms < dawn }).agents.get(agent.id);
        expect(brk, `${agent.id} at ${t}`).toEqual(star);
        checked++;
      }
      // Segments that start after dawn are judged as day, so none of them is stargazing.
      for (const t of times(dawn, SINCE + HALF_HOUR, 5000)) {
        const brk = planAt(t, { agents: [agent], night: (ms) => ms < dawn }).agents.get(agent.id);
        if (brk && brk.startedAt >= dawn) {
          expect(brk.activity, `${agent.id} at ${t}`).not.toBe("stargaze");
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("uses every day activity somewhere across a crew and a half hour", () => {
    const many = crew(40);
    const seen = new Set<string>();
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 20_000)) {
      for (const brk of planAt(t, { agents: many }).agents.values()) seen.add(brk.activity);
    }
    expect([...seen].sort()).toEqual(["bar", "juggle", "pigeons", "smoke", "stroll"]);
  });
});

describe("break planner: sites and spots", () => {
  it("puts bar and smoke activities at a site of that kind, and the rest in the plaza", () => {
    const many = crew(20);
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 20_000)) {
      for (const brk of planAt(t, { agents: many, night: true }).agents.values()) {
        if (brk.activity === "bar" || brk.activity === "smoke") {
          const site = SITES.find((s) => s.id === brk.siteId);
          expect(site?.kind).toBe(brk.activity);
        } else {
          expect(brk.siteId).toBeNull();
        }
      }
    }
  });

  it("never holds more agents at a site than it has spots, with distinct valid spots", () => {
    const many = crew(24);
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 10_000)) {
      const plan = planAt(t, { agents: many, plazaSpots: 30 });
      const used = new Map<string | null, number[]>();
      for (const brk of plan.agents.values()) {
        const list = used.get(brk.siteId) ?? [];
        list.push(brk.spot);
        used.set(brk.siteId, list);
      }
      for (const [siteId, spots] of used) {
        expect(spots.length).toBeLessThanOrEqual(siteSpots(siteId, 30, SITES));
        expect(new Set(spots).size).toBe(spots.length);
        for (const s of spots) {
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThan(siteSpots(siteId, 30, SITES));
        }
      }
    }
  });

  it("sends overflow agents to another activity when the only bar has one spot", () => {
    const sites: BreakSite[] = [{ id: "bar", kind: "bar", spots: 1 }];
    const many = crew(12);
    let sawBar = false;
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 10_000)) {
      const plan = planAt(t, { agents: many, sites, plazaSpots: 20 });
      const atBar = [...plan.agents.values()].filter((b) => b.siteId === "bar");
      expect(atBar.length).toBeLessThanOrEqual(1);
      if (atBar.length === 1) sawBar = true;
      // nobody is dropped for lack of a bar seat: they all still have a break
      expect(plan.agents.size).toBe(12);
    }
    expect(sawBar).toBe(true);
  });

  it("never picks bar or smoke when there are no such sites", () => {
    const many = crew(20);
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 20_000)) {
      for (const brk of planAt(t, { agents: many, sites: [], plazaSpots: 30 }).agents.values()) {
        expect(["bar", "smoke"]).not.toContain(brk.activity);
        expect(brk.siteId).toBeNull();
      }
    }
  });

  it("never exceeds the plaza spot count", () => {
    const many = crew(20);
    for (const t of times(SINCE + MAX_BREAK_DELAY_MS, SINCE + HALF_HOUR, 20_000)) {
      const plan = planAt(t, { agents: many, plazaSpots: 4 });
      const inPlaza = [...plan.agents.values()].filter((b) => b.siteId === null);
      expect(inPlaza.length).toBeLessThanOrEqual(4);
      expect(new Set(inPlaza.map((b) => b.spot)).size).toBe(inPlaza.length);
    }
  });
});

describe("break planner: conversations", () => {
  const many = crew(14);
  const from = SINCE + MAX_BREAK_DELAY_MS;

  /** The pairs the rule gives: members of each place, sorted by ID, taken two at a time. */
  function expectedPairs(plan: BreakPlan): string[] {
    const groups = new Map<string | null, string[]>();
    for (const [id, brk] of plan.agents) {
      const list = groups.get(brk.siteId) ?? [];
      list.push(id);
      groups.set(brk.siteId, list);
    }
    const out: string[] = [];
    for (const [siteId, ids] of groups) {
      ids.sort();
      for (let i = 0; i + 1 < ids.length; i += 2) {
        out.push(`${siteId}|${ids[i]}|${ids[i + 1]}`);
      }
    }
    return out.sort();
  }

  it("pairs agents at the same place two at a time by sorted ID, odd one out stays quiet", () => {
    let sawPair = false;
    for (const t of times(from, from + HALF_HOUR, 7000)) {
      const plan = planAt(t, { agents: many });
      const actual = plan.conversations.map((c) => `${c.siteId}|${c.a}|${c.b}`).sort();
      expect(actual).toEqual(expectedPairs(plan));
      if (actual.length > 0) sawPair = true;
    }
    expect(sawPair).toBe(true);
  });

  it("lists the lower ID as a, and puts each agent in at most one conversation", () => {
    for (const t of times(from, from + HALF_HOUR, 7000)) {
      const plan = planAt(t, { agents: many });
      const members: string[] = [];
      for (const c of plan.conversations) {
        expect(c.a < c.b).toBe(true);
        members.push(c.a, c.b);
      }
      expect(new Set(members).size).toBe(members.length);
    }
  });

  it("only pairs agents that are both on break at that site", () => {
    for (const t of times(from, from + HALF_HOUR, 7000)) {
      const plan = planAt(t, { agents: many });
      for (const c of plan.conversations) {
        expect(plan.agents.get(c.a)?.siteId).toBe(c.siteId);
        expect(plan.agents.get(c.b)?.siteId).toBe(c.siteId);
      }
    }
  });

  it("holds no conversation for a lone agent", () => {
    const plan = planAt(from + 60_000, { agents: crew(1) });
    expect(plan.conversations).toEqual([]);
  });

  it("pairs two agents sharing the plaza (no sites, so everyone is in the plaza)", () => {
    const two = crew(2);
    const plan = planAt(from + 10_000, { agents: two, sites: [], plazaSpots: 5 });
    expect(plan.agents.size).toBe(2);
    expect(plan.conversations).toHaveLength(1);
    expect(plan.conversations[0]).toMatchObject({ a: "agent-00", b: "agent-01", siteId: null });
  });

  it("pairs three plaza agents as the two lowest IDs, leaving the third out", () => {
    const three = crew(3);
    const plan = planAt(from + 10_000, { agents: three, sites: [], plazaSpots: 5 });
    expect(plan.conversations).toHaveLength(1);
    expect(plan.conversations[0]).toMatchObject({ a: "agent-00", b: "agent-01" });
  });

  it("keeps pairs stable for the same sorted IDs whatever the input order", () => {
    const two = crew(2);
    const t = from + 10_000;
    const a = planAt(t, { agents: two, sites: [], plazaSpots: 5 });
    const b = planAt(t, { agents: [...two].reverse(), sites: [], plazaSpots: 5 });
    expect(b.conversations).toEqual(a.conversations);
  });

  it("uses a 6 s bubble turn", () => {
    expect(BUBBLE_TURN_MS).toBe(6000);
  });

  it("advances the turn index every 6 s, with turnStartedAt bounding now", () => {
    const two = crew(2);
    const opts = { agents: two, sites: [] as BreakSite[], plazaSpots: 5 };
    const start = from + 10_000;
    const first = planAt(start, opts).conversations[0] as Conversation;
    expect(first).toBeDefined();
    expect(first.turnStartedAt).toBeLessThanOrEqual(start);
    expect(first.turnStartedAt + BUBBLE_TURN_MS).toBeGreaterThan(start);

    const next = planAt(first.turnStartedAt + BUBBLE_TURN_MS, opts)
      .conversations[0] as Conversation;
    expect(next.turn).toBe(first.turn + 1);
    expect(next.turnStartedAt).toBe(first.turnStartedAt + BUBBLE_TURN_MS);

    const justBefore = planAt(first.turnStartedAt + BUBBLE_TURN_MS - 1, opts)
      .conversations[0] as Conversation;
    expect(justBefore.turn).toBe(first.turn);

    const later = planAt(first.turnStartedAt + 5 * BUBBLE_TURN_MS + 17, opts)
      .conversations[0] as Conversation;
    expect(later.turn).toBe(first.turn + 5);
  });

  it("derives the turn from the clock alone, so replay at T matches live at T", () => {
    const two = crew(2);
    const opts = { agents: two, sites: [] as BreakSite[], plazaSpots: 5 };
    const t = from + 45_000;
    const live = planAt(t, opts).conversations;
    for (const other of [t - 20_000, t + 20_000, from]) planAt(other, opts);
    expect(planAt(t, opts).conversations).toEqual(live);
  });
});
