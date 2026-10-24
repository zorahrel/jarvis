#!/bin/sh
# Una tantum (cron OpenClaw 8e44faea, 25/10 04:40): toglie dal registro attività del proxy VDM le 461 scritture dei
# test dell'hub del 24/10 (priority-set e account-cap su auto-2, 01:42-09:27, le sole quattro forme del vecchio test
# vivo) e fa ripartire il VDM, che così legge anche il prompt del riassunto in italiano.
# Il VDM tiene il registro in memoria e lo riscrive a ogni evento: va fermato prima di filtrare, poi riavviato.
#   vdm-pulizia-registro.sh --prova   dice cosa toglierebbe, senza fermare niente né scrivere
set -eu
NODE=/opt/homebrew/bin/node   # il cron di OpenClaw non ha per forza node nel PATH
LOG="$HOME/.claude/account-switcher/activity-log.json"
PLIST="$HOME/Library/LaunchAgents/com.jarvis.vdm.plist"
SVC="gui/$(id -u)/com.jarvis.vdm"
FILTER='
const fs = require("fs");
const [file, mode] = process.argv.slice(1);
const all = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(all)) throw new Error("registro senza elenco");
const from = Date.parse("2026-10-24T01:40:00+02:00"), to = Date.parse("2026-10-24T09:28:00+02:00");
const isTest = (e) => e.name === "auto-2" && e.ts >= from && e.ts <= to && (
  (e.type === "priority-set" && (e.priority === 8 || e.priority === 1)) ||
  (e.type === "account-cap" && ((e.fiveH === 63 && e.sevenD === 64) || (e.fiveH == null && e.sevenD == null))));
const keep = all.filter((e) => !isTest(e));
console.log(`voci ${all.length}, di prova ${all.length - keep.length}, restano ${keep.length}`);
if (mode === "scrivi") { fs.writeFileSync(file + ".nuovo", JSON.stringify(keep)); fs.renameSync(file + ".nuovo", file); }
'
if [ "${1:-}" = "--prova" ]; then "$NODE" -e "$FILTER" "$LOG" prova; exit 0; fi

up() { curl -s -o /dev/null -m 3 http://127.0.0.1:3335/api/settings; }
# qualunque cosa vada storta dopo lo stop, il VDM riparte: senza, le sessioni di Claude restano senza proxy
restart() { launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "$SVC" 2>/dev/null || true; }
trap restart EXIT
cp "$LOG" "$LOG.bak-prima-pulizia-$(date +%Y%m%d-%H%M)"
launchctl bootout "$SVC" 2>/dev/null || true
i=0; while up && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
if up; then echo "il VDM non si ferma: registro non toccato"; exit 1; fi
"$NODE" -e "$FILTER" "$LOG" scrivi
trap - EXIT; restart
i=0; until up || [ $i -ge 40 ]; do sleep 0.5; i=$((i + 1)); done
up || { echo "VDM non ripartito dopo la pulizia"; exit 1; }
echo "VDM ripartito"
