#!/bin/bash
# Name whoever kills the jcode daemon, in the case the decoy cannot cover.
#
# The decoy (sigterm-decoy/) catches pattern kills: `pkill -f jcode`, `killall
# jcode`, anything matching argv. It cannot catch a killer that resolves the pid
# a different way - reading ~/.jcode/servers.json, walking `ps`, or an internal
# `jcode server reload --force` that targets the registry entry. That killer
# sends SIGTERM to exactly one pid and the decoy never sees it.
#
# So: keep a short rolling record of every process on the machine, and the
# moment the daemon's pid disappears, freeze the last snapshots. Whoever sent
# the signal was almost certainly alive in the seconds before, and its argv is
# in the dump.
#
# Cost is deliberate: one `ps` per second, kept for ~90 seconds in memory. On a
# death it writes one dump, filtered to the processes that plausibly did it -
# a full `ps` history is 4 MB per death and buries the answer in Chrome helpers.

set -u

LOG="$HOME/.jcode/logs/killer-forensics.log"
DUMPDIR="$HOME/.jcode/logs/killer-dumps"
WINDOW=90   # seconds of history kept
INTERVAL=1

mkdir -p "$DUMPDIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

daemon_pid() {
  # The real daemon only: the decoy shares its argv, so it must be excluded by
  # path or we would watch the wrong process and dump on every decoy restart.
  ps -eo pid,command \
    | awk '/builds\/shared-server\/jcode --provider/ && !/awk/ {print $1; exit}'
}

log "forensics up (window ${WINDOW}s, interval ${INTERVAL}s)"

# Only processes that could plausibly signal the daemon. Everything else (Chrome
# helpers, Spotlight, the window server) turns a readable dump into 4 MB of
# noise. Verified on a real kill: the culprit's full command line survives this
# filter, because a killer must name jcode, a signal, or be a script/shell.
RELEVANT='kill|jcode|claude|codex|node|python|bun|supervis|guard|launchd|bash|zsh|sh -c'

prune() {
  grep -aE "$RELEVANT" | grep -avE 'Google Chrome|Chromium|WebKit|Spotlight|mdworker|com\.apple'
}

ring=()
watched=""

while true; do
  snapshot="=== $(date '+%Y-%m-%d %H:%M:%S') ===
$(ps -eo pid,ppid,lstart,command 2>/dev/null | prune)"
  ring+=("$snapshot")
  if (( ${#ring[@]} > WINDOW / INTERVAL )); then
    ring=("${ring[@]:1}")
  fi

  current="$(daemon_pid)"

  if [[ -n "$watched" && "$current" != "$watched" ]]; then
    # The pid we were watching is gone. Freeze everything we know.
    stamp="$(date '+%Y%m%d-%H%M%S')"
    dump="$DUMPDIR/death-$stamp.txt"
    {
      echo "daemon pid $watched disappeared at $(date '+%Y-%m-%d %H:%M:%S')"
      echo "replacement pid: ${current:-none}"
      echo
      echo "### last ${#ring[@]} process snapshots, oldest first"
      printf '%s\n\n' "${ring[@]}"
    } >"$dump"
    log "daemon $watched died -> $dump"

    # Keep only the last 20 deaths: half a megabyte each, and a killer that
    # fires 15 times a day would otherwise quietly fill the disk.
    ls -t "$DUMPDIR"/death-*.txt 2>/dev/null | tail -n +21 | while read -r old; do
      rm -f "$old"
    done
  fi

  watched="$current"
  sleep "$INTERVAL"
done
