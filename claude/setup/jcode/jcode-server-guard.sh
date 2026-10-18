#!/bin/bash
# Keep a jcode background server listening on the socket the TUI clients use.
#
# Why this exists: when the server dies (2026-08-16: 15 times in one day, SIGTERM
# from an unidentified sender), every attached client falls into an endless
# "Remote reconnect attempt" loop. The stale <tmp>/jcode.sock file stays on disk,
# so connect() returns ECONNREFUSED and the client retries every 30s forever
# instead of unlinking the socket and spawning a replacement. Recovery required
# opening a new jcode window by hand; sessions sat dead for 45 minutes.
#
# This guard only ever STARTS a server, never stops or kills one: if something
# is answering on the socket it does nothing at all.
#
# It runs as a long-lived loop rather than a launchd StartInterval tick: the
# probe is cheap (a connect() on a unix socket) and polling every few seconds
# cuts the dead window from ~23s to ~5s. launchd keeps this process alive.
#
# The socket path is derived exactly like the clients derive it, from the
# per-user Darwin temp dir. Do not "simplify" this to $TMPDIR: processes spawned
# inside a jcode session inherit TMPDIR=~/.jcode/scratch and would guard the
# wrong path (that mismatch is what spawns the phantom servers in the log).

set -u

TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"
export TMPDIR
SOCKET="${TMPDIR%/}/jcode.sock"
JCODE="$HOME/.local/bin/jcode"
LOG="$HOME/.jcode/logs/server-guard.log"
POLL_SECONDS="${JCODE_GUARD_POLL_SECONDS:-5}"

# Never restart faster than this. A server that dies instantly on startup would
# otherwise turn the guard into a spawn loop that hides the real failure.
BACKOFF_SECONDS=15

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

alive() {
  /usr/bin/python3 - "$SOCKET" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(2)
try:
    s.connect(sys.argv[1])
except Exception:
    sys.exit(1)
finally:
    s.close()
PY
}

log "guard loop up (poll ${POLL_SECONDS}s, socket $SOCKET)"

# Phantom servers: a jcode launched from inside a session inherits
# TMPDIR=~/.jcode/scratch and starts a server on a socket no client watches. It
# dies 5 minutes later with "idle with no clients" and leaves the stale socket
# behind - 26 of them in one day, against 17 real servers. They are not just
# noise: they register in the same servers.json as the real daemon, and their
# idle-shutdown SIGTERMs show up in the log looking exactly like the deaths we
# are hunting. That cost real diagnosis time on 2026-08-16.
GHOST_SOCKET="$HOME/.jcode/scratch/jcode.sock"

reap_ghost_socket() {
  [[ -S "$GHOST_SOCKET" ]] || return 0
  # Only remove it if nothing is listening: a live phantom is still serving
  # some confused client, and yanking its socket would break that session.
  if ! /usr/bin/python3 - "$GHOST_SOCKET" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(2)
try:
    s.connect(sys.argv[1])
except Exception:
    sys.exit(1)
finally:
    s.close()
PY
  then
    rm -f "$GHOST_SOCKET" && log "removed stale phantom socket $GHOST_SOCKET"
  fi
}

last_start=0
while true; do
  # Cheap (a stat, then a connect only if the socket exists), so every tick.
  # A slower cadence was tried first and failed its own test: the stale socket
  # sat there for minutes, which is exactly the window in which it pollutes the
  # registry and the log.
  reap_ghost_socket

  if ! alive; then
    now=$(date +%s)
    if (( now - last_start < BACKOFF_SECONDS )); then
      sleep "$POLL_SECONDS"
      continue
    fi
    last_start=$now
    down_at=$now
    log "socket dead ($SOCKET), starting server"
    "$JCODE" server start >>"$LOG" 2>&1
    sleep 3
    if alive; then
      log "server back up after $(( $(date +%s) - down_at ))s"
    else
      log "START FAILED - socket still dead"
    fi
  fi
  sleep "$POLL_SECONDS"
done
