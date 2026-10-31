# Retro: {{milestone}}

Generated {{generated_at}} by `pnpm retro {{key}}` from GitHub data. Charts and numbers are generated; the sections marked *written* are filled in by the lead.

## At a glance

| Tickets planned | Added | Done | Dropped | Calendar days | Peak parallel | First-pass reviews | Flakes | NOT RUN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| {{planned}} | {{added}} | {{done}} | {{dropped}} | {{days}} | {{peak_parallel}} | {{first_pass_pct}} | {{flakes}} | {{not_run}} |

## Timeline by lane

```mermaid
gantt
  title {{milestone}}: first commit to merge
  dateFormat YYYY-MM-DDTHH:mm
  axisFormat %b %d
  {{#lanes}}
  section {{lane}}
  {{#tickets}}
  {{key}} {{short_title}} :{{status_tag}} {{start}}, {{end}}
  {{/tickets}}
  {{/lanes}}
```

## Burn-down

```mermaid
xychart-beta
  title "Open tickets per day"
  x-axis [{{day_labels}}]
  y-axis "Open tickets" 0 --> {{planned_plus_added}}
  line [{{open_per_day}}]
  line [{{ideal_per_day}}]
```

## Parallelism

```mermaid
xychart-beta
  title "Tickets in progress per day"
  x-axis [{{day_labels}}]
  y-axis "In progress" 0 --> {{peak_parallel}}
  bar [{{in_progress_per_day}}]
```

## Cycle time by size

```mermaid
xychart-beta
  title "Average hours from first commit to merge"
  x-axis [S, M, L]
  y-axis "Hours" 0 --> {{max_cycle_hours}}
  bar [{{cycle_s}}, {{cycle_m}}, {{cycle_l}}]
```

## Review outcomes

```mermaid
pie title Reviews
  "Passed first review" : {{first_pass}}
  "One fix round" : {{one_fix}}
  "Escalated" : {{escalated}}
```

## Quality signals

| CI failures | Re-runs | Flakes | Tests NOT RUN | Security findings (high / medium / low) |
| --- | --- | --- | --- | --- |
| {{ci_failures}} | {{reruns}} | {{flakes}} | {{not_run}} | {{sec_high}} / {{sec_med}} / {{sec_low}} |

## Plan versus actual

{{plan_vs_actual_table}}

## What went well *(written)*

## What hurt *(written)*

## Lessons from this milestone *(written)*

Links to the [LESSONS.md](../LESSONS.md) entries recorded during the milestone, plus any new ones from this retro.

## Changes for the next milestone *(written)*

Each change is either applied now (with a link to the commit or ticket) or proposed to the owner in the gate summary.
