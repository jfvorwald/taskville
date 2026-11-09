#!/bin/sh
# Taskville permission forwarder for Codex's PermissionRequest command hook (A1.02,
# docs/spikes/S-5-codex.md). POSIX sh plus curl; no Node, no bash-isms.
#
# Codex has no http hook type, so this script plays the part Claude Code's http hook plays: it
# posts the hook JSON from stdin to the engine's bridge route and prints the engine's answer on
# stdout, which is the allow or deny JSON Codex reads. The engine holds the request for a few
# seconds (the Codex hold window, 5 s) so a paired viewer can answer it.
#
# With no decision it prints nothing and exits 0, and Codex shows its own prompt. That is the
# answer for: no live engine, no bridge token, any failure, any non-2xx status, an empty body.
# Unlike the telemetry shim (codex-shim.sh) it never spools: a permission request that is not
# answered now has no use later.
#
# ENVIRONMENT and the LIVE ENGINE rule are the telemetry shim's (see the header of
# claude-code-shim.sh): TASKVILLE_HOME, TASKVILLE_URL (loopback only), and nothing is sent unless
# $TASKVILLE_HOME/engine.json names a live engine at that origin. The home directory is refused if
# it is a symlink, owned by another user, or writable by group or other.
#
# REQUEST
#   POST <TASKVILLE_URL>/v1/bridge/codex/permission
#   Authorization: Bearer <first line of $TASKVILLE_HOME/bridge-token>
#   Content-Type: application/json
#   Body: the stdin bytes verbatim (at most 1 MiB; a larger hook is not forwarded).
#   curl --max-time 8: over the hold window, under the installed hook timeout (10 s).
#
# SECURITY
#   The token goes to curl in a config read from stdin (`curl -K -`) by the shell's builtin
#   printf, so it never appears in the process list. curl runs with -q, --noproxy '*',
#   --proto =http, and no redirect following. The request body and the answer pass through a
#   private temporary directory inside the Taskville home, removed on exit.

umask 077
exec 2>/dev/null 3<&0 || exit 0

CAP=1048576
work=

drain() {
  cat <&3 >/dev/null 3<&- &
  exec 3<&-
}

# Exits 0 with no decision before the hook JSON was read.
bail() {
  drain
  exit 0
}

cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM PIPE

strip_slashes() {
  _s=$1
  while :; do
    case $_s in
      / | '') break ;;
      */) _s=${_s%/} ;;
      *) break ;;
    esac
  done
  printf '%s' "$_s"
}

home=${TASKVILLE_HOME:-}
if [ -z "$home" ]; then
  [ -n "${HOME:-}" ] || bail
  home=$HOME/.taskville
fi
case $home in
  '~')
    [ -n "${HOME:-}" ] || bail
    home=$HOME
    ;;
  '~/'*)
    [ -n "${HOME:-}" ] || bail
    home=$HOME/${home#??}
    ;;
esac
home=$(strip_slashes "$home")
[ -n "$home" ] || bail
case $home in /*) ;; *) home=./$home ;; esac

private_dir() {
  [ -O "$1" ] || return 1
  _loose=$(find "$1" -prune \( -perm -0020 -o -perm -0002 \) -print 2>/dev/null) || return 1
  [ -z "$_loose" ]
}

if [ -h "$home" ] || [ ! -d "$home" ]; then bail; fi
private_dir "$home" || bail

canon_origin() {
  case $1 in
    http://localhost:*) printf '%s' "http://127.0.0.1:${1#http://localhost:}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# True when $home/engine.json names a live engine at origin $1 (same check as the telemetry shim).
live_engine() {
  _ej=$home/engine.json
  if [ -h "$_ej" ] || [ ! -f "$_ej" ]; then return 1; fi
  _info=$(head -c 4096 "$_ej" | tr -d '\r\n') || return 1
  case $_info in '{'*'}') ;; *) return 1 ;; esac
  _eurl=$(printf '%s' "$_info" | sed -n 's/.*"url":"\([^"\\]*\)".*/\1/p')
  _epid=$(printf '%s' "$_info" | sed -n 's/.*"pid":\([0-9]*\)[,}].*/\1/p')
  [ -n "$_eurl" ] || return 1
  [ "$(canon_origin "$(strip_slashes "$_eurl")")" = "$1" ] || return 1
  case $_epid in '' | *[!0-9]*) return 1 ;; esac
  [ ${#_epid} -le 7 ] && [ "$_epid" -gt 0 ] || return 1
  kill -0 "$_epid" 2>/dev/null
}

command -v curl >/dev/null || bail

url=$(canon_origin "$(strip_slashes "${TASKVILLE_URL:-http://127.0.0.1:4807}")")
case $url in
  http://127.0.0.1:*) port=${url#http://127.0.0.1:} ;;
  http://localhost:*) port=${url#http://localhost:} ;;
  *) bail ;;
esac
case $port in '' | *[!0-9]*) bail ;; esac
[ ${#port} -le 5 ] || bail

live_engine "$url" || bail

token_file=$home/bridge-token
if [ -h "$token_file" ] || [ ! -f "$token_file" ]; then bail; fi
token=
IFS= read -r token <"$token_file" || [ -n "$token" ] || bail
case $token in '' | *[!A-Za-z0-9_-]*) bail ;; esac
[ ${#token} -ge 32 ] || bail

work=$(mktemp -d "$home/.codex-permission.XXXXXX") || work=
[ -n "$work" ] || bail

head -c $((CAP + 1)) >"$work/body" || bail
size=$(wc -c <"$work/body" | tr -d ' ')
case $size in '' | *[!0-9]* | 0) bail ;; esac
if [ "$size" -gt "$CAP" ]; then bail; fi
drain

status=$(
  printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\nheader = "Expect:"\n' "$token" |
    curl -q -K - -s -4 -o "$work/answer" -w '%{http_code}' \
      --max-time 8 --noproxy '*' --proto =http \
      -X POST --data-binary "@$work/body" \
      "$url/v1/bridge/codex/permission"
)
case $status in 2??) ;; *) exit 0 ;; esac
if [ -f "$work/answer" ] && [ ! -h "$work/answer" ]; then head -c 65536 "$work/answer"; fi
exit 0
