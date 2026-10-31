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
