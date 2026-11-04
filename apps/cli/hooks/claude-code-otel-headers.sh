#!/bin/sh
# Taskville OpenTelemetry headers helper for Claude Code (M5.12). `taskville install claude-code
# --otel` points the `otelHeadersHelper` setting at this script. Claude Code runs it and reads one
# JSON object of headers from stdout; the engine's OTLP receiver needs the CLI token, which is
# read here from $TASKVILLE_HOME/token so it is never written to a settings file.
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
origin=${origin%/}
for endpoint in "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" "${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:-}" \
  "${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}" "${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-}"; do
  case $endpoint in
    '' | "$origin" | "$origin"/*) ;;
    *) exit 0 ;;
  esac
done
token_file=$home/token
if [ -h "$token_file" ] || [ ! -f "$token_file" ]; then exit 1; fi
token=
IFS= read -r token <"$token_file" || [ -n "$token" ] || exit 1
case $token in '' | *[!A-Za-z0-9_-]*) exit 1 ;; esac
printf '{"Authorization":"Bearer %s"}\n' "$token"
