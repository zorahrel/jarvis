#!/bin/bash
# Prova dal vivo di run.ts, solo a Mac libero (cron una tantum di notte): il Chrome lanciato
# con `open -g -n` non ruba il primo piano, e il guardiano vero lo chiude con Browser.close.
# Porta 19298 e profilo temporaneo: il Chrome della skill e il suo login non si toccano.
# L'esito va su stdout (registro del cron) e in ~/.cache/cdp-mcp/skill-watchdog.log.
DIR=$(cd "$(dirname "$0")" && pwd)
PORT=19298
BUN="$HOME/.bun/bin/bun"
say() { echo "$1"; mkdir -p "$HOME/.cache/cdp-mcp"; echo "$(date -u +%FT%TZ) live-check $1" >>"$HOME/.cache/cdp-mcp/skill-watchdog.log"; }
"$HOME/bin/mac-libero" 300 >/dev/null || { say "⏳ Prova del Chrome di chatgpt-image non fatta: Mac in uso alle $(date +%H:%M)."; exit 75; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/cgi-live.XXXXXX")
up() { curl -sf -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null; }
front() { lsappinfo info -only name "$(lsappinfo front)" | sed -E 's/.*="?([^"]*)"?$/\1/'; }

f0=$(front)
# stessi argomenti della skill; --use-mock-keychain solo qui: un profilo nuovo non chiede il portachiavi
open -g -n -a "/Applications/Google Chrome.app" --args --user-data-dir="$tmp/profile" \
  --remote-debugging-port=$PORT --no-first-run --no-default-browser-check --use-mock-keychain about:blank
s=$SECONDS; until up || [ $((SECONDS-s)) -gt 20 ]; do sleep 0.5; done
if ! up; then say "❌ chatgpt-image: il Chrome di prova non ha aperto la CDP in 20 s."; trash "$tmp"; exit 1; fi
sleep 2; f1=$(front)

mkdir -p "$tmp/home/.cache/cdp-mcp"; printf T > "$tmp/home/.cache/cdp-mcp/skill-last-use-$PORT"
s=$SECONDS
HOME="$tmp/home" "$BUN" "$DIR/run.ts" --watchdog T --port $PORT --idle-min 0.1; rc=$?
dt=$((SECONDS-s))
closed=yes; up && closed=no
# tampone solo se il guardiano ha fallito: il Chrome di prova non resta acceso
[ $closed = no ] && pkill -f -- "--user-data-dir=$tmp/profile"
sleep 1; trash "$tmp"

if [ "$f1" = "Google Chrome" ] && [ "$f0" != "Google Chrome" ]; then
  say "❌ chatgpt-image: open -g non basta, Chrome e' passato davanti (prima: $f0)."; exit 1
fi
if [ $closed = no ] || [ $rc != 0 ]; then
  say "❌ chatgpt-image: il guardiano non ha chiuso il Chrome di prova (exit $rc, $dt s)."; exit 1
fi
say "✅ chatgpt-image: Chrome partito dietro ($f0 resta davanti), chiuso dal guardiano in $dt s."
