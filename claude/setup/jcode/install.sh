#!/bin/bash
# Install the jcode resilience pieces: a guard that resurrects the background
# server, and a decoy that names whoever is killing it.
#
# Both live here (versioned) and are deployed to the paths launchd expects.
# Re-running is safe: it rebuilds, reloads, and reports state.
#
# Background, 2026-08-16: the jcode daemon took 15 SIGTERMs in one day from an
# unidentified sender. Each death left <tmp>/jcode.sock on disk, so every
# attached client fell into a 30s reconnect loop that never unlinks the stale
# socket nor spawns a replacement — 8 sessions sat dead for 45 minutes before
# anyone noticed. The guard removes the outage; the decoy exists to end the
# mystery, because a supervisor that hides the cause is a permanent tax.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.jcode/bin"
AGENTS="$HOME/Library/LaunchAgents"

mkdir -p "$BIN/sigterm-decoy" "$AGENTS" "$HOME/.jcode/logs"

install -m 755 "$HERE/jcode-server-guard.sh" "$BIN/jcode-server-guard.sh"
install -m 755 "$HERE/jcode-killer-forensics.sh" "$BIN/jcode-killer-forensics.sh"
install -m 644 "$HERE/sigterm-decoy/decoy.c" "$BIN/sigterm-decoy/decoy.c"

# vdm routing: the gate decides, the watch reports, the lockdown enforces. They
# resolve each other by directory, so they have to be installed side by side.
install -m 755 "$HERE/jcode-vdm-gate.sh" "$BIN/jcode-vdm-gate.sh"
install -m 755 "$HERE/jcode-vdm-watch.sh" "$BIN/jcode-vdm-watch.sh"
install -m 755 "$HERE/jcode-vdm-lockdown.sh" "$BIN/jcode-vdm-lockdown.sh"

# The decoy must be named `jcode` and take the daemon's argv: that is the whole
# point — a pattern kill aimed at the daemon has to match it too.
cc -O2 -o "$BIN/sigterm-decoy/jcode" "$BIN/sigterm-decoy/decoy.c"

for label in com.jarvis.jcode-server-guard com.jarvis.jcode-sigterm-decoy com.jarvis.jcode-killer-forensics com.jarvis.jcode-vdm-watch; do
  install -m 644 "$HERE/launchagents/$label.plist" "$AGENTS/$label.plist"
  # bootout is asynchronous: bootstrapping while the old job is still dying
  # fails with EIO and leaves that agent down, with the installer none the
  # wiser. Measured on 2026-08-16 - the decoy silently stayed dead. So: unload,
  # wait for it to actually be gone, then load.
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl list | grep -q "$label" || break
    sleep 0.5
  done
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist" 2>/dev/null \
    || launchctl load "$AGENTS/$label.plist" 2>/dev/null || true
done

sleep 2
printf '\n--- installed ---\n'
launchctl list | grep -E 'jcode-server-guard|jcode-sigterm-decoy|jcode-killer-forensics|jcode-vdm-watch' || {
  printf 'FAILED: no agent is loaded\n' >&2
  exit 1
}

# RunAtLoad means this job may be mid-launch when we look; give it the same
# grace the bootout loop above gets rather than failing on a race.
for _ in $(seq 1 10); do
  launchctl list | grep 'com.jarvis.jcode-vdm-watch' >/dev/null && break
  sleep 0.5
done
launchctl list | grep 'com.jarvis.jcode-vdm-watch' >/dev/null \
  && printf 'vdm watch loaded (log: ~/.jcode/logs/vdm-watch.log)\n' \
  || { printf 'FAILED: vdm watch is not loaded\n' >&2; exit 1; }

pgrep -f "$BIN/sigterm-decoy/jcode" >/dev/null \
  && printf 'decoy running (log: ~/.jcode/logs/sigterm-decoy.log)\n' \
  || { printf 'FAILED: decoy is not running\n' >&2; exit 1; }

pgrep -f "$BIN/jcode-killer-forensics.sh" >/dev/null \
  && printf 'forensics running (dumps: ~/.jcode/logs/killer-dumps/)\n' \
  || { printf 'FAILED: forensics is not running\n' >&2; exit 1; }

pgrep -f "$BIN/jcode-server-guard.sh" >/dev/null \
  && printf 'guard running (log: ~/.jcode/logs/server-guard.log)\n' \
  || { printf 'FAILED: guard is not running\n' >&2; exit 1; }
