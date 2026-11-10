# Agent panel readability (design)

**Date:** 2026-11-08 · **Author:** lead · **Request:** the owner, 2026-11-08: "The interface when clicking on waiting or other agents need to be beautified so it's more pleasant to read, now it's just text and hard to scroll through."

## What is wrong today

Screenshots of the panel on main (recorded subagent and team fixtures, 1440x900):

- **Cards overlap.** In the Live tab, rows of the virtualized feed draw on top of each other after their content grows (highlighting, evidence arriving), so text sits over text. This alone makes the feed unreadable and the scroll position jumpy.
- **Everything is the same weight.** Each card is a bordered box of 14 px text: a title, "Status: succeeded. Timing: 15 ms", "Path: not reported", the whole tool input as wrapped JSON, then "Output: recorded". Nothing tells the eye what happened.
- **Too narrow and the header scrolls away.** The panel is 320 px wide and the whole panel scrolls, so the agent's name, status and tabs leave the screen as soon as you read down the feed.
- **Crew and Files** show the same plain rows; crew results are long unbroken text.

ARCHITECTURE 2.10 already describes short cards ("Ran `pnpm test` ✓ 0.8 s", "Edited `src/city/path.ts` +4 −2", "Spawned reviewer", "Sent message to Pip") that expand to detail. The fix is to build what 2.10 says, not to change it. The honesty rule stays: a missing field still says "not reported", but inside the expanded details, not on every collapsed card. No ARCHITECTURE change.

## Direction: the agent's logbook

The panel reads like a ship's log of one agent: a single vertical thread down the left edge with a node per tool call, a one-line sentence per entry, details folded away. The thread is the one memorable element; everything else stays quiet and uses the active theme's tokens, so steampunk, cyberpunk, solarpunk and aero each tint it their own way.

### Tokens

Existing theme tokens drive everything: `--tv-surface`, `--tv-text`, `--tv-text-muted`, `--tv-accent`, `--tv-focus`, `--tv-needs-you`, `--tv-radius`, `--tv-font`. New defaults in `apps/web/src/styles/tokens.css` (themes may override):

- `--tv-ok: #5fb98a` (succeeded node), `--tv-fail: #e0605a` (failed node and failure line), `--tv-running: var(--tv-accent)` (pending node, hollow).
- `--tv-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace` for commands, paths and code only.
- `--tv-rule: color-mix(in srgb, var(--tv-text-muted) 28%, transparent)` for the thread and dividers.

Type: prose 14 px / 1.45 in `--tv-font`; entry sentence 14 px weight 500; secondary line 13 px muted; mono 12.5 px. Sentence case everywhere, no all-caps labels.

### Layout

```
┌─ panel (min(440px, 100% - 32px), full height) ───────┐
│ Lead › reviewer #2                                    │  sticky header
│ jfvorwald                                   ● Idle    │
│ Implementing · main · 16 s · notes.txt               │
│ ( Live )  Files   Crew                                │
├───────────────────────────────────────────────────────┤  only this part scrolls
│ ┆                                                     │
│ ● Ran cat missing.txt                          26 ms │  red node: failed
│ ┆   Exit code 1: No such file or directory   Details ▸│
│ ┆                                                     │
│ ● Spawned general-purpose helper                5 ms │
│ ┆   Create hello.txt and cat it              Details ▸│
│ ┆                                                     │
│ ● Sent bo a message                            17 ms │
│ ┆   Both tasks are finished; shutting the team down.  │
│ ○ Running Bash  pnpm test                    running…│  hollow node: pending
│                                    [ Jump to latest ] │
└───────────────────────────────────────────────────────┘
```

- **Entry:** node on the thread (filled `--tv-ok`, filled `--tv-fail`, hollow `--tv-running`, `--tv-needs-you` ring for a pending permission), a sentence built from the tool and its key field (Ran `<command>`, Edited `<file>` +a −b, Wrote `<file>`, Read 3 files, Searched "<query>", Spawned `<type>` helper, Sent `<recipient>` a message, Fetched `<host>`, unknown tools: "Used `<Tool>`"), duration right-aligned in muted tabular numerals, one secondary line (first line of the description, the error, or the message), and a "Details" disclosure.
- **Details** (collapsed by default, except the newest failed entry): the existing evidence views (mini diff, output, written content) and a small key-value list of the input for known tools; the raw JSON only for unknown tools, in a mono block capped in height. "Not reported" fields appear here.
- **Turns:** a quiet divider with the time between turns ("12:04"), so long feeds have landmarks.
- **Header:** sticky; name 18 px weight 600, status as a dot plus word, facts on one line separated by spacing (not middle dots), current file in mono. The tab list is part of the sticky header.
- **Crew tab:** same thread look with one entry per child (status node, name, activity, elapsed); finished children show the first two lines of their result, expandable. Result text stays plain text (ARCHITECTURE 13: never Markdown or HTML).
- **Files tab:** rows with the file name in mono, the directory muted, and the edit count right-aligned.
- **Motion:** none added; expanding a disclosure is instant (reduced motion holds by construction, as the panel notes today). Focus rings use `--tv-focus`.
- **Privacy and honesty:** unchanged rules; privacy mode still hides bodies, and the sentence never shows code or output text, only command, file name and counts.

## Tickets

| Key | Work | Owns | After |
| --- | --- | --- | --- |
| M10.01 | Feed rows never overlap: re-measure a row whenever its content size changes | `apps/web/src/overlays/agent-panel/live/**` | none |
| M10.02 | Live tab as a logbook: sentences, thread nodes, durations, folded details, turn dividers | `apps/web/src/overlays/agent-panel/live/**`, `apps/web/src/overlays/agent-panel/code/**` (styles only) | M10.01 |
| M10.03 | Panel shell, Crew and Files: wider panel, sticky header and tabs, scroll only in the tab slot, new tokens, Crew and Files in the same style | `apps/web/src/overlays/agent-panel/{shell,crew,files}/**`, `apps/web/src/styles/tokens.css` | none |

Done when for the set: browser tests prove no two feed rows overlap after content grows; the sentence and node for each tool kind; details collapsed by default and "not reported" only inside details; the header stays visible while the feed scrolls; and a screenshot pass of the panel in two themes is attached to the M10.02 and M10.03 PRs.
