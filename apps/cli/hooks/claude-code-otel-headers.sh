#!/bin/sh
# Taskville OpenTelemetry headers helper for Claude Code (M5.12). `taskville install claude-code
# --otel` points the `otelHeadersHelper` setting at this script. Claude Code runs it and reads one
# JSON object of headers from stdout; the engine's OTLP receiver needs the CLI token, which is
# read here from $TASKVILLE_HOME/token so it is never written to a settings file.
#
# Hands out the token only to a live engine (M7.30, #434): $TASKVILLE_HOME/engine.json (one JSON
# line written by `taskville serve`) must be a regular file whose "url" equals the target origin
# (TASKVILLE_URL, trailing slashes stripped) and whose "pid" (digits only, not 0) is alive
# (`kill -0`). Otherwise it prints nothing and exits 0, as for a foreign endpoint, so a stale file
# or another process on the port never gets the token. Read with sed, no jq. "localhost" is treated
# as 127.0.0.1. Remaining limits: a same-user process can still listen while the engine is alive;
# see apps/cli/docs/hooks-security.md.
#
# Caching: Claude Code caches the helper output and refreshes it periodically (debounced; the helper
# is not re-run per export). A header printed while the engine was live can keep being sent after
# the engine stops, until the next refresh. A helper run while the engine is down yields no header,
# so exports get 401 and metrics are lost until the next refresh.
#
# Prints nothing and exits 1 when the home or token is missing or not a plain token file (a
# symlink, or characters outside A-Za-z0-9_-): Claude Code then exports without the header and the
# engine answers 401, which is the honest failure. The token is never echoed anywhere else.
home=${TASKVILLE_HOME:-}
[ -n "$home" ] || exit 1
# Only to the engine: every inherited OTLP endpoint variable must be unset or the engine's
# loopback origin (TASKVILLE_URL, default http://127.0.0.1:4807), equal to it or continuing with
# "/" (so "http://127.0.0.1:4807.evil.example" and "...4807@evil.example" do not match). Otherwise
# print nothing and exit 0: Claude Code may resolve any of these from a shared settings file or
# the user's own collector, and none of them may receive the token.
origin=${TASKVILLE_URL:-http://127.0.0.1:4807}
while :; do
  case $origin in
    */) origin=${origin%/} ;;
    *) break ;;
  esac
done
for endpoint in "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" "${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:-}" \
  "${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}" "${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-}"; do
  case $endpoint in
    '' | "$origin" | "$origin"/*) ;;
    *) exit 0 ;;
  esac
done
engine_json=$home/engine.json
if [ -h "$engine_json" ] || [ ! -f "$engine_json" ]; then exit 0; fi
info=$(head -c 4096 "$engine_json" | tr -d '\r\n') || exit 0
case $info in '{'*'}') ;; *) exit 0 ;; esac
engine_url=$(printf '%s' "$info" | sed -n 's/.*"url":"\([^"\\]*\)".*/\1/p')
engine_pid=$(printf '%s' "$info" | sed -n 's/.*"pid":\([0-9]*\)[,}].*/\1/p')
while :; do
  case $engine_url in
    */) engine_url=${engine_url%/} ;;
    *) break ;;
  esac
done
# "localhost" is 127.0.0.1 (exact host only), in the recorded url and the target alike.
case $engine_url in http://localhost:*) engine_url=http://127.0.0.1:${engine_url#http://localhost:} ;; esac
case $origin in http://localhost:*) origin=http://127.0.0.1:${origin#http://localhost:} ;; esac
[ -n "$engine_url" ] && [ "$engine_url" = "$origin" ] || exit 0
case $engine_pid in '' | *[!0-9]*) exit 0 ;; esac
# At most 7 digits: some shells truncate an oversized pid to 0, and kill 0 signals the caller's group.
[ ${#engine_pid} -le 7 ] && [ "$engine_pid" -gt 0 ] || exit 0
kill -0 "$engine_pid" 2>/dev/null || exit 0
token_file=$home/token
if [ -h "$token_file" ] || [ ! -f "$token_file" ]; then exit 1; fi
token=
IFS= read -r token <"$token_file" || [ -n "$token" ] || exit 1
case $token in '' | *[!A-Za-z0-9_-]*) exit 1 ;; esac
printf '{"Authorization":"Bearer %s"}\n' "$token"
