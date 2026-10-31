# Quickstart: validate the Headless Foundation

A run guide proving feature 001 works end to end. Commands describe the
intended interface ([contracts/cli.md](contracts/cli.md)); none exist yet.

## Prerequisites

- Node.js 26 and pnpm on PATH
- From the Git repository root: `pnpm install`
- Use a scratch home so nothing touches real data: `export TASKVILLE_HOME=$(mktemp -d)`

## 1. Fast check

```sh
pnpm check          # typecheck + lint + unit + integration tests
```

Expected: exit 0. This is also what `.claude/check.sh` runs.

## 2. Ingest and inspect (US1)

```sh
pnpm taskville serve --headless &          # terminal A
pnpm taskville events ingest --file fixtures/events/basic-two-agents.jsonl
pnpm taskville status --project demo
```

Expected: ingest prints `accepted 12 / duplicate 0 / conflict 0 / rejected 0`;
status shows two agents, one `running` on a task, header `1 active · 0 waiting`.

```sh
pnpm taskville events ingest --file fixtures/events/basic-two-agents.jsonl
```

Expected: `accepted 0 / duplicate 12`, status unchanged.

```sh
pnpm taskville events ingest --file fixtures/events/conflicts.jsonl     # exit 4, conflicts listed
pnpm taskville events ingest --file fixtures/events/invalid.jsonl       # exit 4, line-numbered rejections
```

## 3. Follow and resume (US2)

```sh
pnpm taskville events follow --project demo --after 0     # terminal B: prints backlog then waits
pnpm taskville demo start --project demo --seed 42 --speed 20 --duration 10m   # terminal C
```

Stop terminal B mid-demo, note the last printed cursor N, restart with
`--after N`. Expected: first event printed is N+1; no repeats.

Write without a token:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4807/v1/events/batch -d '{"events":[]}'
```

Expected: `401`.

## 4. Determinism (US3)

```sh
pnpm taskville demo run --seed 42 --duration 2h --offline
pnpm taskville demo run --seed 42 --duration 2h --offline
```

Expected: both print the same `stateHash`. A different seed prints a different hash.

## 5. Health

```sh
curl -s http://127.0.0.1:4807/health
```

Expected: `"status":"ok"`, `"walMode":true`.

## Not covered here

Crash-after-commit, 100-cycle reconnect, slow-consumer cutoff, and reducer-version
rebuild are proved by integration tests in step 1, not by hand.
