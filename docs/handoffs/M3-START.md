# M3 Live city: launch plan for a fresh lead session

Lead-owned. Written 2026-10-31 18:45 EDT by the lead session taskville-20 (Claude Opus 5.5) after M2 stopped at G2. A new lead session reads this file, reconciles live state, and starts M3 from it. Workers read [WORKER-BRIEF.md](WORKER-BRIEF.md), not this file.

## Why M3 can start now

- [ROADMAP](../ROADMAP.md) wave 2 runs M2 and M3 in parallel. M3 is blocked only by G1 (#19), and G1 is closed. Every M3 ticket's **Blocked by** chain starts at #26 (M3.01), which is blocked only by #19.
- G2 (#40) stays open for the owner. It blocks M4 and M5, and the M2 follow-ups #214, #215 and #222, but nothing in M3. Do not close it; do not start M4, M5 or those follow-ups.
- Main at handoff: `8422545`. No M3 branch, PR or worktree exists. No workers are running.

## Owner policy carried over from the M2 resume

**Models.** Every assignment names provider, model and effort. No silent model inheritance (L-116). No max or ultra effort by default. The CTO hierarchy stays dormant.

| Work | Claude | Codex |
| --- | --- | --- |
| Mechanical reports and docs | Haiku 5.5, low | gpt-6-luna, low |
| Tests and ordinary implementation | Sonnet 5.5, medium | gpt-6.1-sol, medium |
| Routine review | Sonnet 5.5, medium | gpt-6.1-sol, medium |
| Security-sensitive work | Sonnet 5.5, high | gpt-6.1-sol, high |
| Difficult debugging or architecture | Opus 5.5, high | gpt-6-astra, high |

**Workers.** Start with two. One ticket and one isolated worktree per worker. A Codex ticket the owner reserves (via `/codex-handoff`) is exclusive. Freeze a worker's branch after its final handoff. After two failed fixes, stop and investigate or escalate. The lead alone merges and edits the board, STATUS, LESSONS and gate issues.

**Usage and time.** Read the real usage and reset display before assigning; if it cannot be read, record a provisional cutoff and say so. Stop normal assignments 1 h before the cutoff, drain at 30 min, finish shutdown at 15 min. Stop heavy assignments at 70% usage, all new ones at 80%, wind down by 90%. Perf runs only with the machine reserved (no workers running; L-113). On shutdown, record each worker's branch, HEAD, checks and blockers; stop owned watchers and heartbeats. Never install automatic restarts or change user-level config. Never deploy to production.

## Batches and assignments

Two workers at a time. Within a batch, take tickets in the order listed. A ticket starts only when every ticket in its **Blocked by** is merged.

| Batch | Ticket | Owns | Model and effort | Notes |
| --- | --- | --- | --- | --- |
| 1 | M3.01 #26 web scaffold served by the engine | `apps/web/**` (scaffold), engine static hosting | Claude Sonnet 5.5, high | Security-sensitive: static file serving (path traversal, same origin) and the pairing landing page (code from the URL fragment, session secret in localStorage). Runs alone; it owns every shared file below. |
| 2 | M3.02 #30 client data layer | `apps/web/src/data/**` | Claude Sonnet 5.5, medium | SSE reader with the session header; uses the shared domain reducer. |
| 2 | M3.04 #32 city layout and buildings | `apps/web/src/city/layout/**`, `apps/web/src/city/buildings/**` | Claude Sonnet 5.5, medium | Screenshot next to `docs/ui/01-minimal-3d-city.png`. |
| 2 | M3.03 #31 overlay host and anchors | `apps/web/src/overlays/host/**`, `apps/web/src/overlays/header/**` | Claude Sonnet 5.5, medium | |
| 2 | M3.05 #33 block agents | `apps/web/src/city/agents/**` | Claude Sonnet 5.5, medium | |
| 3 | M3.06 #36 navigation and presentation state machine | `apps/web/src/city/movement/**` | Claude Opus 5.5, high | Size L, the milestone's core state machine. Needs #30, #32, #33. |
| 3 | M3.07 #37 theme system and cyberpunk | `apps/web/src/themes/core/**`, `apps/web/src/themes/cyberpunk/**` | Claude Sonnet 5.5, medium | Its theme contract gates #41 to #44. |
| 3 | M3.11 #38 camera, selection, glow | `apps/web/src/city/interaction/**` | Claude Sonnet 5.5, medium | |
| 3 | M3.15 #39 settings panel | `apps/web/src/overlays/settings/**` | Claude Sonnet 5.5, medium | Needs only #31. Can start as soon as #31 merges. |
| 4 | M3.08 #41, M3.09 #42, M3.10 #43 themes | `apps/web/src/themes/<name>/**` | Claude Sonnet 5.5, medium (or Codex gpt-6.1-sol, medium) | Disjoint paths; good Codex handoff candidates. |
| 4 | M3.12 #44 day and night lighting | `apps/web/src/city/lighting/**` | Claude Sonnet 5.5, medium | |
| 4 | M3.13 #45 celebrations | `apps/web/src/city/effects/**` | Claude Sonnet 5.5, medium | Needs #36. |
| 4 | M3.14 #46 accessibility and comfort | `apps/web/src/overlays/agent-list/**`, `apps/web/src/city/runtime/**` | Claude Sonnet 5.5, medium | Needs #31 and #36. |
| 4 | M3.16 #47 performance budget and smoke | `tests/e2e/web/**` | Claude Sonnet 5.5, medium | Needs #36, #37, #38. The fps and idle CPU measurement runs with the machine reserved; no other worker runs during it. |
| 5 | M3.RT #97 retro | `docs/retros/M3.md`, `docs/LESSONS.md` | Claude Haiku 5.5, low for the lessons copy; the lead writes the sections | After every M3 ticket merges. |

Then wave verification on main with no workers running, the G3 summary on #48 (retro link first), `waiting:user`, STATUS, and stop.

## Shared files and integration order

Separate worktrees do not separate these files. Serialize changes to them through the lead.

- `pnpm-lock.yaml`, root `package.json`, `apps/web/package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `biome.json`, `vitest.config.ts`, `.github/workflows/ci.yml`. **M3.01 adds every dependency the milestone names** (Vite, React, React Three Fiber, Drei, Zustand, React Aria Components, Vitest Browser Mode, Playwright), so later tickets need no dependency change. A later ticket that needs a new dependency stops and reports; the lead lands it in its own small PR first.
- The app entry and scene root that M3.01 creates. Later tickets mount their component there with the smallest edit, declared in the PR; the lead merges in batch order and resolves the conflict on the next branch.
- The store shape from M3.02 and the theme contract from M3.07 are interfaces. A change to either after merge is its own ticket, not a drive-by edit.
- Screenshots and clips go in `docs/tasks/<KEY>/`, next to the task report.
- Protocol, domain reducer and reducer version: M3 should not change them. A ticket that needs to stops and reports.

## Open items for the owner (none blocks M3)

- **G2 #40** is open with `waiting:user`.
- **#176** (no spec-kit feature for M2 to M7). On its default, M3 runs from roadmap tickets with explicit contracts. Its D2 default proposes a constitution amendment, which is a stop-and-ask change; the lead does not make it until the owner answers.
- Other open decisions (#174, #178, #184, #187, #190, #198, #202, #206) concern the engine, protocol and M2 telemetry. None touches `apps/web`.

## Fresh-session start

1. Read CLAUDE.md, this file, [STATUS](../STATUS.md), and the M3 issues.
2. Reconcile live state: `git fetch`, open PRs, worktrees, running agents and sessions, the board. Preserve existing work.
3. Read the usage and reset display; set the cutoff.
4. Create one worktree for M3.01 from current main and assign it with the brief, naming the model and effort above.
</content>
</invoke>
