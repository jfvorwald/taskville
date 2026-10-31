# Lessons learned

A running log, newest first. Anyone working on Taskville adds an entry when something surprises them: a wrong assumption, a failed approach, a flaky test, a review finding worth remembering, a tool quirk. Milestone retros in [retros/](retros/) summarize and link these.

Rules:

- One entry per lesson. Keep it short and specific enough that someone else would act differently next time.
- Never delete an entry. If a lesson turns out wrong, add a new entry that supersedes it and link back.
- Every entry has an **Action**: a change already made (link it), a ticket (link it), or "none, awareness only".

Entry format:

```markdown
### L-<number>: <one-line lesson>
- **Date:** YYYY-MM-DD · **Milestone:** M<n> · **Ticket:** #<issue> · **Recorded by:** <agent or person>
- **What happened:** <one or two sentences>
- **Lesson:** <what to do differently>
- **Action:** <link to change or ticket, or "none, awareness only">
```

## Entries

### L-14: A synchronous open of an untrusted path can hang the test worker
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #7 · **Recorded by:** engine teammate (M1.10)
- **What happened:** `openSync` on a FIFO at the token path blocked the whole Vitest worker, so the per-test timeout never fired and the red run had to be killed by hand. roborev also flagged the FIFO hang in the code.
- **Lesson:** Open untrusted paths with `O_NONBLOCK` and `fstat` before reading; refuse anything that is not a regular file.
- **Action:** Fixed in PR #119 (d292fe9).

### L-13: Read the Host header, not the request URL, for the Host check
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #7 · **Recorded by:** engine teammate (M1.10)
- **What happened:** `@hono/node-server` fills the request URL from its own `hostname` option when a request has no Host header, so a URL-based check would pass a missing Host.
- **Lesson:** Check the raw Host header. Register security middleware with `app.use()` in `createApp` so routes added later inherit it (a test proves it). Never mint pairing codes over HTTP, even behind the CLI token, since agents can read that token.
- **Action:** Done in PR #119.

### L-12: Re-read the contracts after every rebase
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #7 · **Recorded by:** engine teammate (M1.10)
- **What happened:** M1.01 merged new route names, error codes, a 501 commands stub and persistent pairings while M1.10 was being built to the old contract, and the #7 issue still says "node:http router" in its first bullet.
- **Lesson:** Re-read the contract files after each rebase and before review, not only at the start; follow the revision 3 bullet over older wording in a ticket.
- **Action:** none, awareness only.

### L-11: Interactive spike sessions still touch user-level state
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #3, #4 · **Recorded by:** lead
- **What happened:** Running interactive Claude Code sessions in throwaway folders required accepting the folder trust dialog, which added one project entry per spike folder to `~/.claude.json`. One S-2 session ran with default setting sources, so the owner's user-level hooks and plugins fired once for a scratch session. Nothing under `~/.claude/` was edited.
- **Lesson:** "Project-scoped settings only" does not keep a spike out of user state. Spikes should pass `--setting-sources project,local` (or `--settings` alone) on every run, and the plan should say up front that trust-dialog entries will be added, so the owner can approve or clean them.
- **Action:** Reported to the owner at the end of the wave; entries left in place pending the owner's call. Future spike briefs will require explicit setting sources.

### L-10: Split-pane teammates are invisible to the permission bridge
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #4 · **Recorded by:** research-s2 teammate (M1.04)
- **What happened:** In split-pane mode a teammate's permission prompt fires no PermissionRequest hook; the lead only gets a `worker_permission_prompt` Notification. In-process teammates share the lead's `session_id` and are identified by `agent_id`. A roborev high finding caught an unlabelled heuristic parent link in the first draft.
- **Lesson:** Teammate attribution depends on display mode; anything inferred (parent links before `PostToolUse(Agent).tool_response.agentId`, names from notification text) must be labelled heuristic.
- **Action:** Decision ticket #120 for the owner at G1; fixed in PR #118.

### L-9: Spikes that drive Claude Code must set the permission mode and split tmux input
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #3 · **Recorded by:** research-s1 teammate (M1.03)
- **What happened:** An unflagged nested session started in auto mode (the owner's default), and long text plus Enter in one `tmux send-keys` sometimes left the prompt unsubmitted.
- **Lesson:** Pass `--permission-mode default` explicitly, and send text and `C-m` as separate `send-keys` calls.
- **Action:** none, awareness only.

### L-8: Reaching an open hook response does not prove a permission decision took effect
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #3 · **Recorded by:** research-s1 teammate (M1.03)
- **What happened:** The terminal prompt stays answerable while the PermissionRequest hook holds. A terminal Yes leaves the hook request open until timeout and a later hook answer is written successfully but ignored; a terminal No closes the connection within 15 ms and fires no other hook.
- **Lesson:** The bridge must treat city decisions as unconfirmed until telemetry confirms them, and read a closed connection as a terminal No. The focus-dependent short hold in ARCHITECTURE.md 8.1 is not needed.
- **Action:** Decision ticket #116 (hold window and terminal-answer rules) for the owner at G1.

### L-7: A docs alignment ticket that feeds code tickets makes contract decisions
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #1 · **Recorded by:** docs teammate (M1.01)
- **What happened:** Aligning spec 001 meant choosing engine-only event types, a reserved source prefix, and the project registry. roborev found two high findings (dedupe hash taken after truncation; masking scope too narrow) and one medium (request merge key missing the agent) that wording-level review would have missed.
- **Lesson:** Review a contract-alignment docs PR as a design change, and route any choice the architecture does not make to a decision ticket.
- **Action:** Fixed in PR #112; open choices in decision tickets #110 and #114.

### L-6: Vitest 5 configures projects in vitest.config.ts, not a workspace file
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** The plan named `vitest.workspace.ts`, which Vitest 5 no longer uses.
- **Lesson:** Configure test projects under `test.projects` in the root `vitest.config.ts`.
- **Action:** Done in PR #108.

### L-5: pnpm 12 swallows reporter flags meant for Vitest
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** pnpm 12 claims `--reporter`, and `pnpm test -- <flags>` forwards a literal `--` after which Vitest ignores flags.
- **Lesson:** Call `node_modules/.bin/vitest` directly when you need Vitest flags.
- **Action:** none, awareness only.

### L-4: Biome 2.6 formats Markdown, so scope it to code
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** An unscoped `biome check .` failed on the spec-kit skill files.
- **Lesson:** Keep `files.includes` limited to TS, JS and JSON, excluding `.claude/` and `.specify/`.
- **Action:** Done in PR #108 (`biome.json`).

### L-3: Check migrated Biome config by hand
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** `biome migrate --write` on Biome 2.6.4 rewrote `"recommended": true` to `"preset": "none"`, silently disabling every recommended lint rule.
- **Lesson:** After any config migration, diff the result and confirm the rules you expect are still on.
- **Action:** `"preset": "recommended"` set in PR #108.

### L-1: Check the tool's install root before running workflow commands
- **Date:** 2026-10-30 · **Milestone:** planning · **Ticket:** none · **Recorded by:** Claude (planning session)
- **What happened:** Spec Kit had been initialized one directory below the Git root, so its scripts treated `taskville/taskville` as the project root while the architecture placed code at the Git root.
- **Lesson:** Before running a tool's workflow commands, confirm where the tool was initialized and that it matches where the code will live.
- **Action:** `.specify/`, `.claude/skills/` and `specs/` were moved to the Git root on 2026-10-30.

### L-2: Run an independent review before calling a design final
- **Date:** 2026-10-30 · **Milestone:** planning · **Ticket:** none · **Recorded by:** Claude (planning session)
- **What happened:** An independent review of architecture revision 2 found three high-severity gaps: an agent could have approved its own permission prompt with the CLI token, the action card could have hidden part of the input being approved, and needs-you was per project only.
- **Lesson:** Have the security-sensitive parts of a design (anything that grants permission or runs commands) reviewed by someone who did not write them before tickets are cut.
- **Action:** Fixed in ARCHITECTURE.md sections 2.4, 2.8, 9.2 and 13; every milestone that touches auth or commands has a security review ticket.
