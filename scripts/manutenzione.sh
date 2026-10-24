#!/bin/bash
# Manutenzione notturna del Mac: un solo lavoro con i passi in fila, al posto di sei job launchd sparsi tra le 3:00 e le
# 5:30 (Attilio 24/10: «facciamone un'unica, anche allo stesso orario»). launchd com.jarvis.manutenzione, ogni notte 2:30:
# finisce prima di openclaw-safe-update (4:20, OpenClaw fermo), che resta a parte perché vuole il gateway spento.
# Ogni passo scrive una riga JSON in logs/manutenzione/runs.jsonl (giro, passo, ora, durata, esito): l'hub ne fa i passi
# della scheda. Un passo che fallisce non ferma i successivi; l'uscita è 1 se almeno uno è fallito.
# I vecchi job sono in ~/Library/LaunchAgents/disabled/ (com.jarvis.{memgit-snap,disk-hygiene,log-rotate,
# agent-browser-update,quadra-verify,private-backup}.plist): per tornare indietro si rimettono lì.
#   manutenzione.sh            tutti i passi di oggi
#   manutenzione.sh <passo>    solo quel passo (per provarlo a mano)
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
DIR="$HOME/.claude/jarvis/logs/manutenzione"; mkdir -p "$DIR"
RUN="$(date +%Y%m%d-%H%M%S)"
ONLY="${1:-}"
DOW=$(date +%u)   # 1 = lunedì … 7 = domenica
FAILED=0

# passo <id> <etichetta> <minuti massimi> <comando…>
step() {
  local id="$1" label="$2" max="$3"; shift 3
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && return 0
  local t0 rc note outcome
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  echo "== $(date '+%F %T') $id" >> "$DIR/$id.log"
  # tetto di durata: un passo appeso non deve tenere ferma la notte (perl alarm = timeout senza coreutils)
  perl -e 'alarm shift; exec @ARGV or exit 127' $((max * 60)) "$@" >> "$DIR/$id.log" 2>&1
  rc=$?
  [ $rc -eq 142 ] && note="fermato dopo $max min" || note="exit $rc"
  [ $rc -eq 0 ] && outcome=ok || { outcome=error; FAILED=1; }
  local ms=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - t0 ))
  jq -cn --arg run "$RUN" --arg step "$id" --arg label "$label" --argjson at "$t0" --argjson ms "$ms" --arg outcome "$outcome" --arg note "$note" \
    '{run:$run,step:$step,label:$label,at:$at,ms:$ms,outcome:$outcome,note:$note}' >> "$DIR/runs.jsonl"
}
skip() { [ -n "$ONLY" ] && [ "$ONLY" != "$1" ] && return 0
  jq -cn --arg run "$RUN" --arg step "$1" --arg label "$2" --argjson at "$(python3 -c 'import time;print(int(time.time()*1000))')" --arg note "$3" \
    '{run:$run,step:$step,label:$label,at:$at,ms:0,outcome:"skipped",note:$note}' >> "$DIR/runs.jsonl"; }

# 1. Foto della memoria di OpenClaw: per prima, prima che qualunque altro passo o l'update delle 4:20 la tocchi
step memgit-snap "Foto della memoria di OpenClaw" 15 "$HOME/bin/memgit" snap
# 2. Pulizia del disco: scratch, cache e cartelle che ricrescono da sole
step disk-hygiene "Pulizia del disco" 30 /bin/bash "$HOME/.claude/jarvis/router/scripts/disk-hygiene.sh"
# 3. Log troppo grandi accorciati (sopra 50 MB restano le ultime 50 000 righe)
step log-rotate "Log accorciati" 10 /bin/bash "$HOME/.claude/jarvis/scripts/rotate-logs.sh"
# 4. Browser degli agenti OpenClaw aggiornato: una volta a settimana, il lunedì
if [ "$DOW" = 1 ] || [ "$ONLY" = agent-browser-update ]; then
  step agent-browser-update "Browser degli agenti aggiornato" 20 /usr/bin/python3 "$HOME/.openclaw/bin/agent-browser-update"
else skip agent-browser-update "Browser degli agenti aggiornato" "solo il lunedì"; fi
# 5. Prova di ripristino di Quadra (Postgres temporaneo dal backup su R2): una volta a settimana, la domenica
if [ "$DOW" = 7 ] || [ "$ONLY" = quadra-verify ]; then
  step quadra-verify "Prova di ripristino di Quadra" 45 /bin/bash "$HOME/.local/share/quadra-backup/run-verify.sh"
else skip quadra-verify "Prova di ripristino di Quadra" "solo la domenica"; fi
# 6. Modello di come evolve Attilio: rilegge i messaggi della settimana (Haiku), aggiorna previsioni e prove nel
#    privato cifrato, avvisa la Regia se una previsione si è avverata. Il lunedì, prima del backup che lo committa.
if [ "$DOW" = 1 ] || [ "$ONLY" = attilio-evoluzione ]; then
  step attilio-evoluzione "Modello di Attilio aggiornato" 20 /bin/bash "$HOME/.claude/jarvis/private/attilio/bin/settimanale.sh"
else skip attilio-evoluzione "Modello di Attilio aggiornato" "solo il lunedì"; fi
# 6b. Direttive scritte da un lato solo (Jarvis o Claude Code): confronto con Haiku, la lista ad Attilio in Ti aspetta
if [ "$DOW" = 1 ] || [ "$ONLY" = attilio-direttive ]; then
  step attilio-direttive "Direttive allineate tra Jarvis e Claude Code" 15 /usr/bin/python3 -I "$HOME/.claude/jarvis/private/attilio/bin/direttive.py"
else skip attilio-direttive "Direttive allineate tra Jarvis e Claude Code" "solo il lunedì"; fi
# 6c. I tre residenti più pesanti del Mac (footprint vero): per ognuno nuovo una card nella coda notturna
if [ "$DOW" = 1 ] || [ "$ONLY" = residenti ]; then
  step residenti "Residenti più pesanti del Mac" 10 /usr/bin/python3 "$HOME/.claude/jarvis/scripts/mac-health/residenti-settimanali"
else skip residenti "Residenti più pesanti del Mac" "solo il lunedì"; fi
# 7. Backup nel repo privato: per ultimo, così prende anche quello che i passi prima hanno scritto
step private-backup "Backup nel repo privato" 30 /bin/bash "$HOME/.claude/jarvis/private/sync.sh" --commit

exit $FAILED
