#!/bin/sh
# Taskville telemetry shim for Codex command hooks (A1.02, docs/spikes/S-5-codex.md).
# POSIX sh plus curl; no Node, no bash-isms.
#
# This is apps/cli/hooks/claude-code-shim.sh for Codex: same behavior, same safety rules, same
# line format. Its header is the contract for everything not listed here (home and spool
# directory checks, the live-engine rule, the spool line and lock protocol, limits, portability,
# security). Keep the two scripts in step. What differs:
#   - POST <TASKVILLE_URL>/v1/sources/codex/hooks (apps/engine/src/sources/codex/index.ts).
#   - Spool files are codex.jsonl, codex.<sourceEventId>.jsonl and codex.lock (with
#     codex.lock.break), temporaries .codex.*. The engine replays them at start
#     (replayCodexSpool). claude-code.* files are never touched.
#   - Codex runs the hooks installed by `taskville install codex`; SessionEnd and SubagentStop
#     are synchronous with a 1 to 3 second timeout. Every wait here is bounded (curl --max-time
#     1, the lock about 1 s), so the shim stays inside that.
#   - It always exits 0 and prints nothing: Codex reads hook stdout.

umask 077
exec 1>/dev/null 2>&1 3<&0 || exit 0

CAP=5241856
LOCK_TRIES=20
LOCK_NAP=0.05

work=
lock_held=no

# Drains the rest of stdin in a background reader (stdout and stderr already
# point at /dev/null, so it holds no pipe Codex waits on), so Codex
# never writes into a closed pipe and the shim's own run time stays bounded
# however much input is left.
drain() {
  # Explicit fd: an asynchronous command in a non-interactive shell otherwise
  # gets /dev/null as its stdin (POSIX job control off).
  cat <&3 >/dev/null 3<&- &
  exec 3<&-
}

# Exits 0 before the hook JSON was read.
bail() {
  drain
  exit 0
}

cleanup() {
  if [ "$lock_held" = yes ]; then release_lock; fi
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

# --- Home and spool directory ----------------------------------------------

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
# A relative home such as "-data" must never be read as an option.
case $home in /*) ;; *) home=./$home ;; esac

# True when the directory is ours and neither group nor other can write it
# (the engine's rule, apps/engine/src/config/home.ts, ensurePrivateDir). Anyone
# who can write the home can swap the token or the spool; if find fails the
# answer is no.
private_dir() {
  [ -O "$1" ] || return 1
  _loose=$(find "$1" -prune \( -perm -0020 -o -perm -0002 \) -print 2>/dev/null) || return 1
  [ -z "$_loose" ]
}

# A concurrent hook may create either directory first: a failed mkdir is not
# fatal, the checks after it decide. The home is vetted before the spool is
# made inside it, and before anything is read from it or written to it.
if [ ! -e "$home" ] && [ ! -h "$home" ]; then mkdir -p "$home" 2>/dev/null; fi
if [ -h "$home" ] || [ ! -d "$home" ]; then bail; fi
private_dir "$home" || bail
spool=$home/spool
if [ ! -e "$spool" ] && [ ! -h "$spool" ]; then mkdir "$spool" 2>/dev/null; fi
if [ -h "$spool" ] || [ ! -d "$spool" ] || [ ! -w "$spool" ]; then bail; fi
private_dir "$spool" || bail

work=$(mktemp -d "$spool/.codex.XXXXXX") || work=
[ -n "$work" ] || bail

# --- Read the hook JSON -------------------------------------------------------

head -c $((CAP + 1)) >"$work/raw" || bail
size=$(wc -c <"$work/raw" | tr -d ' ')
case $size in '' | *[!0-9]*) bail ;; esac
extra=
if [ "$size" -gt "$CAP" ]; then
  drain
  extra=",\"payloadBytesAtLeast\":$size"
  printf 'null' >"$work/payload"
else
  # Nothing but whitespace: nothing to report.
  grep '[^[:space:]]' "$work/raw" >/dev/null || exit 0
  tr -d '\r\n' <"$work/raw" >"$work/payload" || exit 0
fi
rm -f "$work/raw"

# --- sourceEventId ------------------------------------------------------------

valid_uuid() {
  case $1 in
    *[!0-9a-f-]*) return 1 ;;
    ????????-????-4???-[89ab]???-????????????) return 0 ;;
    *) return 1 ;;
  esac
}

uuid=
if [ -r /proc/sys/kernel/random/uuid ]; then
  uuid=$(tr 'A-F' 'a-f' </proc/sys/kernel/random/uuid)
fi
if ! valid_uuid "$uuid"; then
  uuid=$(uuidgen | tr 'A-F' 'a-f')
fi
if ! valid_uuid "$uuid"; then
  hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  variant=$(printf '%s' "$hex" | cut -c17 | tr '0123456789abcdef' '89ab89ab89ab89ab')
  uuid=$(printf '%s' "$hex" |
    sed "s/^\(........\)\(....\).\(...\).\(...\)\(............\)\$/\1-\2-4\3-$variant\4-\5/")
fi
valid_uuid "$uuid" || exit 0

# --- POST to the engine -------------------------------------------------------

# Prints $1 with the host "localhost" replaced by 127.0.0.1 (exact host only:
# http://localhost:PORT becomes http://127.0.0.1:PORT); anything else unchanged.
canon_origin() {
  case $1 in
    http://localhost:*) printf '%s' "http://127.0.0.1:${1#http://localhost:}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# True when $home/engine.json names a live engine at origin $1: a regular file
# whose one-line JSON object has "url" equal to $1 and a "pid" that is running.
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
  # At most 7 digits: some shells truncate an oversized pid to 0, and kill 0
  # signals the caller's own process group.
  [ ${#_epid} -le 7 ] && [ "$_epid" -gt 0 ] || return 1
  kill -0 "$_epid" 2>/dev/null
}

post() {
  # The oversized marker has no object payload; the endpoint would refuse it.
  [ -z "$extra" ] || return 1
  command -v curl >/dev/null || return 1

  url=$(canon_origin "$(strip_slashes "${TASKVILLE_URL:-http://127.0.0.1:4807}")")
  case $url in
    http://127.0.0.1:*) port=${url#http://127.0.0.1:} ;;
    http://localhost:*) port=${url#http://localhost:} ;;
    *) return 1 ;;
  esac
  case $port in '' | *[!0-9]*) return 1 ;; esac
  [ ${#port} -le 5 ] || return 1

  live_engine "$url" || return 1

  token_file=$home/token
  if [ -h "$token_file" ] || [ ! -f "$token_file" ]; then return 1; fi
  token=
  IFS= read -r token <"$token_file" || [ -n "$token" ] || return 1
  case $token in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ ${#token} -ge 32 ] || return 1

  {
    printf '{"payload":'
    cat "$work/payload"
    printf '%s,"sourceEventId":"%s"}' "$extra" "$uuid"
  } >"$work/body" || return 1

  # printf is a shell builtin, so the token is never on a command line.
  status=$(
    printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\nheader = "Expect:"\n' "$token" |
      curl -q -K - -s -4 -o /dev/null -w '%{http_code}' \
        --max-time 1 --noproxy '*' --proto =http \
        -X POST --data-binary "@$work/body" \
        "$url/v1/sources/codex/hooks"
  )
  case $status in 2??) return 0 ;; *) return 1 ;; esac
}

if post; then exit 0; fi

# --- Spool --------------------------------------------------------------------

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  printf '{"payload":'
  cat "$work/payload"
  printf '%s,"sourceEventId":"%s","spooledAt":"%s"}\n' "$extra" "$uuid" "$now"
} >"$work/line" || exit 0

file=$spool/codex.jsonl
lock=$spool/codex.lock

lock_owner() {
  _owner=
  if [ -f "$1/pid" ] && [ ! -h "$1/pid" ]; then IFS= read -r _owner <"$1/pid"; fi
  printf '%s' "$_owner"
}

# Makes the mkdir lock directory $1 and records our PID in it. Held only when the
# PID file is created too, exclusively (set -C opens it with O_EXCL in sh and
# dash): some mkdir(1)s exit 0 when the directory already exists (uutils
# coreutils before 0.11, the Ubuntu 26.04 default; M7.32), so mkdir alone could
# give two holders. Whoever creates the PID file holds; the other backs off.
claim_dir() {
  mkdir "$1" 2>/dev/null || return 1
  (set -C && printf '%s\n' "$$" >"$1/pid") 2>/dev/null
}

# Removes a lock directory we hold: our PID file, then the directory only if it
# is empty, so a PID a later claimer wrote meanwhile is never deleted.
drop_dir() {
  rm -f "$1/pid"
  rmdir "$1" 2>/dev/null
}

take_lock() {
  claim_dir "$lock" || return 1
  lock_held=yes
  return 0
}

release_lock() {
  lock_held=no
  # Only remove the lock if it is still ours (a waiter may have judged it stale).
  if [ "$(lock_owner "$lock")" = "$$" ]; then drop_dir "$lock"; fi
}

# Removes codex.lock if it is stale. Serialized by codex.lock.break,
# so no other waiter can remove or replace the lock between judging and moving
# it; a live holder never loses its lock (one with a running PID is not stale).
break_stale_lock() {
  breaker=$lock.break
  claim_dir "$breaker" || return 1
  broke=no
  owner=$(lock_owner "$lock")
  stale=no
  case $owner in
    '') [ -n "$(find "$lock" -prune -mmin +1 2>/dev/null)" ] && stale=yes ;;
    *[!0-9]*) ;;
    *) kill -0 "$owner" 2>/dev/null || stale=yes ;;
  esac
  # The holder may have released and exited, and a live shim taken a new lock,
  # since the read (M5.27). A dead holder can no longer release, so a lock that
  # still names it now is the lock moved below.
  if [ "$stale" = yes ] && [ "$(lock_owner "$lock")" != "$owner" ]; then stale=no; fi
  if [ "$stale" = yes ] && mv "$lock" "$work/stale-lock" 2>/dev/null; then broke=yes; fi
  drop_dir "$breaker"
  [ "$broke" = yes ]
}

acquire_lock() {
  tries=0
  while [ "$tries" -lt "$LOCK_TRIES" ]; do
    take_lock && return 0
    tries=$((tries + 1))
    if ! sleep "$LOCK_NAP" 2>/dev/null; then
      # No fractional sleep here: one more try, never a long wait.
      break
    fi
  done
  break_stale_lock && take_lock && return 0
  return 1
}

append_main() {
  if [ -h "$file" ]; then return 1; fi
  if [ -e "$file" ] && [ ! -f "$file" ]; then return 1; fi
  acquire_lock || return 1
  if [ -h "$file" ]; then
    release_lock
    return 1
  fi
  # An existing file must be ours and private before payloads go into it: an
  # owned file is tightened to 0600, anyone else's is left alone.
  if [ -e "$file" ] && { [ ! -O "$file" ] || ! chmod 600 "$file"; }; then
    release_lock
    return 1
  fi
  # A torn last line (a killed writer) gets its LF, so it cannot swallow ours.
  if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then printf '\n' >>"$file"; fi
  if ! cat "$work/line" >>"$file"; then
    # Disk full or similar: try the own file too (a replay deduplicates on the ID).
    release_lock
    return 1
  fi
  release_lock
  return 0
}

if append_main; then exit 0; fi

# Own file: complete on arrival, because rename is atomic within a directory.
mv "$work/line" "$spool/codex.$uuid.jsonl"
exit 0
