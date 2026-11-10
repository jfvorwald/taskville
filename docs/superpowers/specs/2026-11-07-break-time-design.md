# Break time: idle agents do fun things while they wait

**Date:** 2026-11-07 · **Requested by:** the owner, in chat: "If the agents are waiting, make them do fun things, like do a smoke break, get drunk at a bar, interact randomly, come up with fun things. They should also talk to each other about nonsense in the news." The owner chose to skip design questions; the calls below marked *lead's call* are open to their correction.

## Intent

A city full of agents sitting motionless at their desks reads as dead time. Waiting agents should look like they are on a break: wandering to a bar, stepping out for a smoke, chatting with each other about absurd made-up headlines. It is charm, not information. It must never hide anything the owner needs to act on.

## Goals

- Agents in the Waiting state (turn ended, nothing pending) leave their workstation after a short delay and do a break activity.
- Activities: a bar (with a tipsy wobble on the way back), a smoke break, strolling the plaza, and small invented diversions (juggling, stargazing at night, feeding pigeons).
- Two or more agents on break near each other chat: alternating bubbles of nonsense news and reactions.
- The moment an agent gets work or needs the owner, the break ends and the existing rules take over.

## Non-goals

- Real news. Headlines are built-in, made-up phrase data. Taskville is local-first and its CSP blocks remote requests (*lead's call*, forced by ARCHITECTURE section 13).
- AI-written lines. Lines stay plain phrase files, as in section 2.3.
- New sounds.

## Anti-goals (failure even if it works)

- A needs-you or trouble agent looks like it is on a break, or its bubble is crowded out by chatter.
- The Waiting label or the accessible list stops saying Waiting. Breaks are presentation only (constitution IV, section 11: presentation states are derived on the client and never written back).
- History replay shows different breaks or lines than live did at the same moment.
- The scene stops being calm: constant walking, flicker, or a frame rate that never drops when nothing happens (constitution VII, section 11 idle budget).

## Behavior (lead's calls)

**Eligibility.** An agent is break-eligible when its rest state is `waiting` (or `idle` with a live session), it has no needs-you or trouble record, and it is not mid-walk on a real trip. A break starts after the agent has been waiting for a seeded 60 to 120 seconds, so short pauses between turns cause no walking.

**Activity choice.** Deterministic: a hash of agent ID and the waiting record's event ID (the same inputs quips use) picks the activity and its timing, so replay matches live. An agent stays on one activity for a seeded 2 to 5 minutes, then may pick another (stroll legs at most one per 30 seconds).

**Places.** Two new break sites in the empty north and south middle cells of the layout (`buildCityLayout`): **the bar** (north: a counter with stools) and **the smoke corner** (south: a bench and a lamp). Plaza nodes host strolls and chats. Sites have a fixed number of spots; when full, agents pick another activity. Themes style the sites through palette keys only (the theme contract forbids layout changes).

**Chatter.** When two or more agents are on break at the same site (or meet in the plaza), the planner pairs them deterministically (sorted IDs). A pair alternates bubbles: one agent offers a nonsense headline ("BREAKING: Local tab key leaves spaces"), the other reacts ("Saw that coming"). Lines come from a new `banter` section of the phrase files with headlines and reactions per theme. Chatter bubbles rank below needs-you, trouble and the selected agent, and at most one conversation shows at a time within the existing three-bubble cap.

**Ending a break.** Any change that makes the agent working, needs-you or trouble ends the break at once. The agent walks back with the existing navigator rules (needs-you stops at the nearest plaza safe point and shows its marker immediately). After the bar, the walk back has a small wobble unless reduced motion is on.

**Honesty.** The status label, agent panel and accessible list keep showing Waiting, with "on break" as a secondary note. No new hue. The "zzz"/"..." emote is replaced by activity emotes (a puff, a mug, a sparkle) only while on break.

**Calm and performance.** Agents stand still at break spots, so the idle frame-rate drop still applies between trips. No per-frame allocation (props are instanced, emotes pooled).

**Setting.** "Break time" in Settings, on by default because the owner asked for it. Off restores the current behavior (sit at the workstation with "zzz"). Reduced motion keeps breaks but snaps walks (existing navigator behavior) and drops the wobble.

**History.** In history mode the planner runs on the replay clock and places agents directly at their break spot for the moment shown.

## Constraints

- ARCHITECTURE.md sections 1, 2.2 and 2.3 change with this feature (owner request); sections 11 and 13 and constitution IV and VII hold.
- Deterministic and pure planner with an injected clock, unit tested.
- Test first; touch only each ticket's Owns paths; roborev before merge.

## Left to the builders

Exact prop geometry and palette, the emote art, the exact phrase lines (at most 48 characters, no dashes, as the phrase tests require), the stroll path choice, and the wobble curve.

## Tickets

| Key | Work | Owns | After |
| --- | --- | --- | --- |
| M9.01 | Break planner: pure eligibility, activity, site, timing and pairing from agents and a clock | `apps/web/src/city/breaks/**`, `apps/web/test/city/breaks/**` | none |
| M9.02 | Break sites in the layout: bar and smoke corner nodes, spots, props and palette keys | `apps/web/src/city/layout/**`, `apps/web/src/city/buildings/**`, theme palettes | none |
| M9.03 | Banter phrases and conversation bubbles | `apps/web/src/quips/**`, `apps/web/src/overlays/bubbles/**` and their tests | M9.01 types |
| M9.04 | Break time setting and "on break" labels | `apps/web/src/overlays/settings/**`, agent list and panel label code | M9.01 types |
| M9.05 | Navigator and CityAgents wiring: break trips, return, wobble, activity emotes, history placement | `apps/web/src/city/movement/**`, `apps/web/src/city/agents/**`, `apps/web/src/city/attention/**` | M9.01, M9.02 |
| M9.06 | Demo scenario with several agents idle long enough to see breaks | `packages/demo/**`, `apps/cli/src/commands/demo.ts` | none |
| M9.07 | Browser and e2e check of a break, a chat and an interrupted break, plus an idle fps check | `apps/web/e2e/**`, browser tests | M9.03 to M9.06 |
