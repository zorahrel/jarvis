#!/bin/bash
# Barra della memoria del gateway OpenClaw, letta dal registro di oc-memwatch (una riga ogni 10 minuti).
# Colonne: ora pid uptime_s footprint_MB heap_main heap_worker n_worker versione riavvio.
# Esce 0 se nell'ultima ora il footprint è stato sotto SOGLIA_MB e il registro è fresco, 1 altrimenti.
# Scrive sempre una riga nel diario dell'hub; al canale arriva solo il caso peggiore (via cron-clean).
SOGLIA_MB=${SOGLIA_MB:-3500}
LOG=${OC_MEMWATCH_LOG:-$HOME/.claude/jarvis/logs/oc-memwatch.log}
DIARIO=$HOME/.claude/jarvis/scripts/task-sync/diario.mjs
righe=$(tail -6 "$LOG")
ultima=$(printf '%s\n' "$righe" | tail -1)
read -r ts pid up fp _ _ _ ver _ <<<"$ultima"
max=$(printf '%s\n' "$righe" | awk '$4 ~ /^[0-9]+$/ && $4 > m { m = $4 } END { print m + 0 }')
eta=$(( $(date +%s) - $(date -j -f '%Y-%m-%dT%H:%M:%S' "$ts" +%s 2>/dev/null || echo 0) ))
ore=$(awk -v s="${up:-0}" 'BEGIN { printf "%.1f", s / 3600 }')
if [ "$eta" -gt 1800 ]; then
  msg="⚠️ Gateway: il registro della memoria è fermo da $((eta / 60)) minuti, il controllo non può dire nulla"; rc=1
elif [ "$max" -gt "$SOGLIA_MB" ]; then
  msg="⚠️ Gateway: memoria a $max MB nell'ultima ora (soglia $SOGLIA_MB), acceso da $ore h, versione $ver"; rc=1
else
  msg="✅ Gateway: memoria $fp MB (massimo dell'ultima ora $max, soglia $SOGLIA_MB), acceso da $ore h, versione $ver"; rc=0
fi
node "$DIARIO" "$msg" --source "Controllo memoria del gateway" >/dev/null 2>&1
[ "$rc" -ne 0 ] && echo "$msg"
exit "$rc"
