# Quickstart: validate the Headless Foundation

A run guide proving feature 001 works end to end. Commands describe the
intended interface ([contracts/cli.md](contracts/cli.md)); none exist yet.

## Prerequisites

- Node.js 26 and pnpm on PATH
- From the Git repository root: `pnpm install`
- Use a scratch home so nothing touches real data: `export TASKVILLE_HOME=$(mktemp -d)`
- Every route needs a credential ([contracts/http-api.md](contracts/http-api.md)). For
  `curl`, after the engine has started once: `TOKEN=$(cat "$TASKVILLE_HOME/token")`

## 1. Fast check

```sh
pnpm check          # typecheck + lint + unit + integration tests
```

Expected: exit 0. This is also what `.claude/check.sh` runs.

## 2. Ingest and inspect (US1)

```sh
pnpm taskville serve --headless &          # terminal A; prints the pairing URL
pnpm taskville project add --id demo --name Demo --root .
pnpm taskville events ingest --file fixtures/events/basic-two-agents.jsonl
pnpm taskville status --project demo
```

Expected: `project add` exits 0 and `project list` shows `demo` and `unsorted`;
ingest prints `accepted 12 / duplicate 0 / conflict 0 / rejected 0`; status shows
an indented tree with two agents, one `running` on a task, and the header
`Demo · 1 active · 0 needs you · 0 trouble · 0 waiting`. The exact counts are fixed
by the fixture (M1.17).

```sh
pnpm taskville events ingest --file fixtures/events/basic-two-agents.jsonl
```

Expected: `accepted 0 / duplicate 12`, status unchanged.

```sh
pnpm taskville events ingest --file fixtures/events/conflicts.jsonl     # exit 4, conflicts listed
pnpm taskville events ingest --file fixtures/events/invalid.jsonl       # exit 4, line-numbered rejections, including unknown_project
pnpm taskville project list                                              # still only demo and unsorted: nothing was auto-created
pnpm taskville requests --project demo    # read-only list; nothing in the CLI can answer
```

## 3. Follow and resume (US2)

```sh
pnpm taskville events follow --project demo --after 0     # terminal B: prints backlog then waits
pnpm taskville demo start --project demo --seed 42 --pace calm --speed 20 --duration 10m   # terminal C
```

Stop terminal B mid-demo, note the last printed cursor N, restart with
`--after N`. Expected: first event printed is N+1; no repeats.

While the demo runs, `pnpm taskville status --project demo` shows within 10
simulated minutes an agent flagged `needs you` and at least one handoff (US3-2).
Subagents appear indented under their parent; finished ones only with `--all`.

Security checks (every route, reads included):

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4807/v1/projects                     # no credential
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4807/v1/events/batch -d '{"events":[]}'
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Host: evil.example:4807' http://127.0.0.1:4807/v1/projects
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST http://127.0.0.1:4807/v1/commands -d '{}'
```

Expected: `401`, `401`, `403` (`forbidden_host`), `403` (`credential_not_allowed`:
the CLI token can never authorize a command).

## 4. Determinism (US3)

```sh
pnpm taskville demo run --seed 42 --duration 2h --offline
pnpm taskville demo run --seed 42 --duration 2h --offline
pnpm taskville demo run --seed 42 --duration 2h --offline --pace lively
```

Expected: the first two print the same `stateHash`. A different seed or pace prints
a different hash.

## 5. Health

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4807/health
```

Expected: `"status":"ok"`, `"walMode":true`.

## Not covered here

Crash-after-commit, 100-cycle reconnect, slow-consumer cutoff, reducer-version
rebuild, browser pairing, and attention rules are proved by tests in step 1, not by
hand. Latency (SC-005) and 8-hour memory growth (SC-006) are measured by M1.21.
