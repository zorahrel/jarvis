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
#
# Dal 25/10 il server è a richiesta: la guardia è ritirata (jcode 0.99.1 avvia da
# sé il server e toglie il socket stantio, dal client) e al suo posto c'è
# com.jarvis.jcode-idle-stop, che lo spegne dopo 10 minuti da fermo
# (~/.claude/jarvis/scripts/jcode-zombie-sweep --idle-stop). Il client lo avvia dal
# canale shared-server, che punta al lanciatore ~/.jcode/signed/server-launch: fa
# partire la copia firmata responsabile di sé per TCC, come la faceva la guardia.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.jcode/bin"
AGENTS="$HOME/Library/LaunchAgents"

mkdir -p "$BIN/sigterm-decoy" "$AGENTS" "$HOME/.jcode/logs"

install -m 755 "$HERE/jcode-killer-forensics.sh" "$BIN/jcode-killer-forensics.sh"
install -m 644 "$HERE/sigterm-decoy/decoy.c" "$BIN/sigterm-decoy/decoy.c"

# vdm routing: the gate decides, the watch reports, the lockdown enforces. They
# resolve each other by directory, so they have to be installed side by side.
install -m 755 "$HERE/jcode-vdm-gate.sh" "$BIN/jcode-vdm-gate.sh"
install -m 755 "$HERE/jcode-vdm-watch.sh" "$BIN/jcode-vdm-watch.sh"
install -m 755 "$HERE/jcode-vdm-lockdown.sh" "$BIN/jcode-vdm-lockdown.sh"

# The decoy must be named `jcode` and take the daemon's argv: that is the whole
# point — a pattern kill aimed at the daemon has to match it too.
# /usr/bin/cc e non cc: nel PATH di Attilio ~/bin/cc apre una sessione Claude in tmux.
/usr/bin/cc -O2 -o "$BIN/sigterm-decoy/jcode" "$BIN/sigterm-decoy/decoy.c"

# Il lanciatore del server (server-launch/, barra server-launch-test.sh) e chi ci punta il canale. Compilato a parte e
# poi rinominato: un server già partito dal lanciatore vecchio tiene il suo inode.
install -m 755 "$HERE/jcode-tcc-pin.sh" "$BIN/jcode-tcc-pin.sh"
mkdir -p "$HOME/.jcode/signed"
/usr/bin/cc -O2 -o "$HOME/.jcode/signed/.server-launch.$$" "$HERE/server-launch/server-launch.c"
mv -f "$HOME/.jcode/signed/.server-launch.$$" "$HOME/.jcode/signed/server-launch"
"$BIN/jcode-tcc-pin.sh" sync

# la guardia, se c'è ancora, esce: rialzerebbe il server che idle-stop spegne
if [[ -f "$AGENTS/com.jarvis.jcode-server-guard.plist" ]]; then
  launchctl bootout "gui/$(id -u)/com.jarvis.jcode-server-guard" 2>/dev/null || true
  mkdir -p "$AGENTS/disabled" && mv -f "$AGENTS/com.jarvis.jcode-server-guard.plist" "$AGENTS/disabled/"
fi

for label in com.jarvis.jcode-idle-stop com.jarvis.jcode-sigterm-decoy com.jarvis.jcode-killer-forensics com.jarvis.jcode-vdm-watch; do
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
launchctl list | grep -E 'jcode-idle-stop|jcode-sigterm-decoy|jcode-killer-forensics|jcode-vdm-watch' || {
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

launchctl list | grep 'com.jarvis.jcode-idle-stop' >/dev/null \
  && printf 'idle stop loaded (log: ~/.jcode/logs/idle-stop.log)\n' \
  || { printf 'FAILED: idle stop is not loaded\n' >&2; exit 1; }
