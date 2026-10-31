#!/bin/sh
# Task-tier completion gate: typecheck, lint, unit and integration tests. Never e2e.
set -eu
cd "$(dirname "$0")/.."
exec pnpm check
