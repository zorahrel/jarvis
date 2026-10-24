#!/bin/bash
# Una tantum (24/10): appena il gateway OpenClaw e' libero accende il plugin errori-italiano e riavvia,
# cosi' entra anche la patch openclaw-pinned-fallback (scritta su dist alle 02:52, quattro minuti dopo
# l'ultimo riavvio). La config del plugin si scrive solo qui: cambiare `plugins` ricarica i plugin a
# caldo, e a gateway occupato non lo vogliamo. Al massimo 6 h, poi procede comunque (come oc-restart).
# Esito in ~/.claude/jarvis/state/errori-italiano-attiva.log; WhatsApp ad Attilio solo se fallisce.
LOG=~/.claude/jarvis/state/errori-italiano-attiva.log
PLUGIN=~/Projects/openclaw-errori-italiano
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
end=$(( $(date +%s) + 6 * 3600 ))
say "parto: attendo il gateway libero"
while :; do
  out=$(~/bin/oc-restart --dry-run 2>&1)
  if echo "$out" | grep -q "riavvierebbe subito"; then say "gateway libero"; break; fi
  [ "$(date +%s)" -gt "$end" ] && { say "6 h scadute, procedo comunque: $(echo "$out" | head -1)"; break; }
  sleep 180
done

batch=$(mktemp)
python3 - "$PLUGIN" > "$batch" <<'EOF'
import json, os, sys
c = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json")))
p = c["plugins"]
paths = p.get("load", {}).get("paths", [])
allow = p.get("allow", [])
ops = []
if sys.argv[1] not in paths:
    ops.append({"path": "plugins.load.paths", "value": paths + [sys.argv[1]]})
if "errori-italiano" not in allow:
    ops.append({"path": "plugins.allow", "value": allow + ["errori-italiano"]})
if not (p.get("entries", {}).get("errori-italiano") or {}).get("enabled"):
    ops.append({"path": "plugins.entries.errori-italiano", "value": {"enabled": True}})
print(json.dumps(ops))
EOF
if [ "$(cat "$batch")" != "[]" ]; then
  (cd ~/.openclaw && openclaw config set --batch-file "$batch") >> "$LOG" 2>&1 || say "config set FALLITO"
fi
rm -f "$batch"
~/bin/oc-restart --now >> "$LOG" 2>&1
sleep 30

fail=""
~/.claude/jarvis/scripts/openclaw-pinned-fallback/openclaw-pinned-fallback.py check >> "$LOG" 2>&1 || fail="patch ripiego non attiva"
since=$(date -u -v-10M '+%Y-%m-%dT%H:%M')  # events.log e' in UTC
awk -F'\t' -v s="$since" '$1 >= s && $3 == "register"' ~/.openclaw/state/errori-italiano/events.log 2>/dev/null | grep -q . \
  || fail="${fail:+$fail, }plugin errori-italiano non caricato"
if [ -n "$fail" ]; then
  say "ROSSO: $fail"
  # destinatario dal cron del brief mattutino (come openclaw-safe-update): il repo e' pubblico
  d=$(openclaw cron get c34dcc15-c2c1-4c5c-8ffa-51b9054827f1 --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin).get("delivery") or {}; print(d.get("channel",""), d.get("to",""))')
  set -- $d
  [ -n "${2:-}" ] && openclaw message send --channel "$1" --target "$2" -m "❌ Ripiego dei modelli non attivo dopo il riavvio di Jarvis: $fail." >> "$LOG" 2>&1
else
  say "VERDE: patch ripiego attiva e plugin errori-italiano caricato"
fi
