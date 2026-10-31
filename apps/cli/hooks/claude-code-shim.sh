#!/bin/sh
# Taskville telemetry shim for Claude Code async command hooks
# (ARCHITECTURE.md section 8.1). POSIX sh plus curl; no Node, no bash-isms.
#
# Claude Code runs this for every telemetry hook with the hook JSON on stdin.
# The shim posts it to the engine and, if that fails for any reason, appends it
# to a spool file the engine ingests on its next start. It never blocks or
# fails the agent: every wait is bounded, it always exits 0, and it prints
# nothing (hook stdout can be interpreted by Claude Code; stderr is discarded).
#
# ENVIRONMENT
#   TASKVILLE_HOME  Taskville home, as the engine resolves it (apps/engine/src/
#                   config/home.ts): $TASKVILLE_HOME, else ~/.taskville. A
#                   leading "~" or "~/" is expanded. A relative path resolves
#                   against the hook's working directory, so installers should
#                   write an absolute one.
#   TASKVILLE_URL   Engine root, default http://127.0.0.1:4807. Only
#                   http://127.0.0.1:<port> or http://localhost:<port> (with an
#                   optional trailing slash) is accepted; anything else is not
#                   contacted and the event is spooled, so the token never
#                   leaves loopback. The engine's port is not read from
#                   config.json: an installer for a non-default port must set
#                   TASKVILLE_URL in the hook command.
#
# REQUEST (the hooks endpoint, M2.02 / #21: apps/engine/src/sources/claude-code/route.ts)
#   POST <TASKVILLE_URL>/v1/sources/claude-code/hooks
#   Authorization: Bearer <contents of $TASKVILLE_HOME/token>
#   Content-Type: application/json
#   No Origin header (a bearer POST needs none, contracts/http-api.md check 3).
#   Body, one JSON object, keys in this order:
#     {"payload":<hook JSON>,"sourceEventId":"<uuid>"}
#   An oversized payload (see LIMITS) is never posted: the endpoint takes only
#   an object payload, so it goes straight to the spool as a marker line.
#   <hook JSON> is the stdin bytes verbatim except that CR and LF are removed
#   (in valid JSON they can only be whitespace between tokens, so the value is
#   unchanged). The shim does not parse or redact it; the engine validates and
#   masks at ingest. The shim's own keys come after "payload" on purpose:
#   JSON.parse keeps the last duplicate key, so text in a malformed payload can
#   never override sourceEventId. The endpoint refuses any other key and a
#   payload that is not an object (400). Any 2xx is success; anything else (connect
#   error, the 1 s timeout, a redirect, 4xx, 5xx) spools the event.
#
# SPOOL (consumed by spool ingest, M2.07 / #28). Sensitive: holds unredacted
# hook payloads (prompts, tool inputs and outputs).
#   Directory  $TASKVILLE_HOME/spool (mode 0700). Files are created 0600.
#   Main file  claude-code.jsonl, appended under the lock below. An existing
#              file is set to 0600 first; one owned by another user is never
#              appended to (the event goes to its own file).
#   Own files  claude-code.<sourceEventId>.jsonl, one event each, written when
#              the lock cannot be taken within about 1 s or the main file is a
#              symlink, not a regular file, or owned by another user. Written to a temporary name in
#              the spool directory and renamed, so they are always complete.
#   Temporary  .claude-code.* (dot files): incomplete, never ingest them. One
#              older than a minute was left by a killed shim and can be deleted.
#   Line       One JSON object per line, LF-terminated, keys in this order:
#     {"payload":<hook JSON>,"sourceEventId":"<uuid>","spooledAt":"<UTC>"}
#   or, oversized:
#     {"payload":null,"payloadBytesAtLeast":<n>,"sourceEventId":"<uuid>","spooledAt":"<UTC>"}
#   spooledAt is `date -u +%Y-%m-%dT%H:%M:%SZ` (second precision), taken when
#   the hook ran. sourceEventId is the same ID the failed POST carried, so an
#   event that did reach the engine (say, a response lost to the timeout)
#   deduplicates on replay. A line that does not parse (a shim killed
#   mid-append, or a malformed payload) must be skipped, not fatal: the shim
#   starts a fresh line when the file does not end in LF, so a torn line never
#   swallows the next event.
#   Lock       claude-code.lock, a directory made with mkdir (atomic), holding
#              a file "pid" with the holder's PID. Any reader that renames or
#              truncates claude-code.jsonl must hold this lock while doing so.
#              A lock is stale when its PID is not running, or when it has no
#              PID file and is more than a minute old. A lock whose PID is
#              running is never broken (a reused PID only costs per-event
#              files). Breaking is serialized by a second mkdir lock,
#              claude-code.lock.break: only its holder may judge and remove
#              claude-code.lock, and holders only ever remove their own lock,
#              so the lock judged stale is the lock removed. The break lock is
#              held for a few milliseconds and never reclaimed automatically;
#              if a shim is killed while holding it, later events go to
#              per-event files until it is removed by hand. Nothing is lost.
#
# LIMITS
#   At most 5 MiB minus 1 KiB (5,241,856 bytes) of hook JSON is kept: the
#   endpoint's body limit is 5 MiB (MAX_HOOK_BODY_BYTES = MAX_BATCH_BYTES,
#   contracts/http-api.md) and the wrapper adds well under 1 KiB, so every
#   posted body and every spool line fits it. A larger payload is not posted
#   (the endpoint would answer 413) and is spooled as the null marker above,
#   so one huge tool output grows the spool by a short line only. The engine
#   cuts evidence bodies to 64 KB anyway (ARCHITECTURE.md 7.4).
#   payloadBytesAtLeast is a lower bound: the shim reads only cap + 1 bytes
#   and drains the rest unread.
#   Waits: curl --max-time 1; the lock about 1 s (20 tries of 50 ms).
#
# PORTABILITY
#   Tested under macOS /bin/sh (bash 3.2 in POSIX mode) and dash. Uses only
#   POSIX utilities except: head -c (macOS, GNU, busybox), mktemp, find -mmin
#   (stale-lock age only), and sleep with a fraction (falls back to one try).
#   sourceEventId comes from /proc/sys/kernel/random/uuid (Linux), else
#   uuidgen (macOS, util-linux), else 16 bytes of /dev/urandom formatted as a
#   version 4 UUID. Output is always lowercase.
#
# SECURITY
#   The token is passed to curl in a config read from stdin (`curl -K -`) by
#   the shell's builtin printf, so it never appears in the process list. curl
#   runs with -q (ignores ~/.curlrc), --noproxy '*' (ignores proxy variables),
#   --proto =http, and no redirect following. The home and spool directories
#   are refused if they are symlinks, if another user owns them, or if group or
#   other can write them: nothing is read from or written to them, the event is
#   not posted, and the shim exits 0 silently (M2.23).

umask 077
exec 1>/dev/null 2>&1 3<&0 || exit 0

CAP=5241856
LOCK_TRIES=20
LOCK_NAP=0.05

work=
lock_held=no

# Drains the rest of stdin in a background reader (stdout and stderr already
# point at /dev/null, so it holds no pipe Claude Code waits on), so Claude Code
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

work=$(mktemp -d "$spool/.claude-code.XXXXXX") || work=
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

post() {
  # The oversized marker has no object payload; the endpoint would refuse it.
  [ -z "$extra" ] || return 1
  command -v curl >/dev/null || return 1

  url=$(strip_slashes "${TASKVILLE_URL:-http://127.0.0.1:4807}")
  case $url in
    http://127.0.0.1:*) port=${url#http://127.0.0.1:} ;;
    http://localhost:*) port=${url#http://localhost:} ;;
    *) return 1 ;;
  esac
  case $port in '' | *[!0-9]*) return 1 ;; esac
  [ ${#port} -le 5 ] || return 1

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
        "$url/v1/sources/claude-code/hooks"
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

file=$spool/claude-code.jsonl
lock=$spool/claude-code.lock

lock_owner() {
  _owner=
  if [ -f "$1/pid" ] && [ ! -h "$1/pid" ]; then IFS= read -r _owner <"$1/pid"; fi
  printf '%s' "$_owner"
}

take_lock() {
  if mkdir "$lock" 2>/dev/null; then
    lock_held=yes
    printf '%s\n' "$$" >"$lock/pid"
    return 0
  fi
  return 1
}

release_lock() {
  lock_held=no
  # Only remove the lock if it is still ours (a waiter may have judged it stale).
  if [ "$(lock_owner "$lock")" = "$$" ]; then rm -rf "$lock"; fi
}

# Removes claude-code.lock if it is stale. Serialized by claude-code.lock.break,
# so no other waiter can remove or replace the lock between judging and moving
# it; a live holder never loses its lock (one with a running PID is not stale).
break_stale_lock() {
  breaker=$lock.break
  mkdir "$breaker" 2>/dev/null || return 1
  broke=no
  owner=$(lock_owner "$lock")
  stale=no
  case $owner in
    '') [ -n "$(find "$lock" -prune -mmin +1 2>/dev/null)" ] && stale=yes ;;
    *[!0-9]*) ;;
    *) kill -0 "$owner" 2>/dev/null || stale=yes ;;
  esac
  if [ "$stale" = yes ] && mv "$lock" "$work/stale-lock" 2>/dev/null; then broke=yes; fi
  rmdir "$breaker" 2>/dev/null
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
mv "$work/line" "$spool/claude-code.$uuid.jsonl"
exit 0
