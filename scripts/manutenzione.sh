#!/bin/bash
# Manutenzione notturna del Mac: un solo lavoro con i passi in fila, al posto di sei job launchd sparsi tra le 3:00 e le
# 5:30 (Attilio 24/10: «facciamone un'unica, anche allo stesso orario»). launchd com.jarvis.manutenzione, ogni notte 2:30:
# finisce prima di openclaw-safe-update (4:20, OpenClaw fermo), che resta a parte perché vuole il gateway spento.
# Ogni passo scrive una riga JSON in logs/manutenzione/runs.jsonl (giro, passo, ora, durata, esito): l'hub ne fa i passi
# della scheda. Un passo che fallisce non ferma i successivi; l'uscita è 1 se almeno uno è fallito.
# I vecchi job sono in ~/Library/LaunchAgents/disabled/ (com.jarvis.{memgit-snap,disk-hygiene,log-rotate,
# agent-browser-update,private-backup}.plist e quello della prova di ripristino): per tornare indietro si rimettono lì.
#   manutenzione.sh            tutti i passi di oggi
#   manutenzione.sh <passo>    solo quel passo (per provarlo a mano)
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
DIR="$HOME/.claude/jarvis/logs/manutenzione"; mkdir -p "$DIR"
# Una sola manutenzione alla volta. Il 25/10 launchd l'ha lanciata due volte a un secondo di distanza
# (giri 023004 e 023005): le due prove di ripristino di un backup si sono pestate e una ha fallito il download
# dopo 21 minuti. Chi arriva secondo esce subito con 75, senza scrivere righe in runs.jsonl.
if [ -z "${MANUTENZIONE_LOCK:-}" ]; then
  export MANUTENZIONE_LOCK=1
  exec /usr/bin/lockf -s -t 0 "$DIR/.lock" /bin/bash "$0" "$@"
fi
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
  # tetto di durata: un passo appeso non deve tenere ferma la notte. Ferma il gruppo intero, non il solo
  # figlio: col vecchio alarm di perl un git ucciso a metà lasciava git-crypt clean appeso (25/10)
  "$HOME/.claude/jarvis/scripts/group-timeout/group-timeout" $((max * 60)) "$@" >> "$DIR/$id.log" 2>&1
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
# 5. Passi extra di questo Mac (la prova di ripristino settimanale di un backup di un cliente): nome, comando e giorno
#    stanno fuori dal repo pubblico, in ~/.config/jarvis/manutenzione-extra.sh, che usa step e skip, DOW e ONLY di qui.
#    File assente: nessun errore, una riga in extra.log.
EXTRA="$HOME/.config/jarvis/manutenzione-extra.sh"
if [ -f "$EXTRA" ]; then . "$EXTRA" || echo "$(date '+%F %T') $EXTRA: uscito con errore" >> "$DIR/extra.log"
else echo "$(date '+%F %T') $EXTRA non c'è: nessun passo extra" >> "$DIR/extra.log"; fi
# 6. Modello di come evolve Attilio, ogni notte (30/10, prima il lunedì): segnali con Haiku, previsioni e oggi.md con Opus,
#    punteggio delle previsioni con Haiku, mosse reversibili nella coda notturna. Prima del backup che lo committa.
step attilio-evoluzione "Modello di Attilio aggiornato" 45 /usr/bin/python3 -I "$HOME/.claude/jarvis/private/attilio/bin/giornaliero.py"
# 6b. Direttive scritte da un lato solo (Jarvis o Claude Code): confronto con Haiku, la lista ad Attilio in Ti aspetta
if [ "$DOW" = 1 ] || [ "$ONLY" = attilio-direttive ]; then
  step attilio-direttive "Direttive allineate tra Jarvis e Claude Code" 15 /usr/bin/python3 -I "$HOME/.claude/jarvis/private/attilio/bin/direttive.py"
else skip attilio-direttive "Direttive allineate tra Jarvis e Claude Code" "solo il lunedì"; fi
# 6c. I tre residenti più pesanti del Mac (footprint vero): per ognuno nuovo una card nella coda notturna
if [ "$DOW" = 1 ] || [ "$ONLY" = residenti ]; then
  step residenti "Residenti più pesanti del Mac" 10 /usr/bin/python3 "$HOME/.claude/jarvis/scripts/mac-health/residenti-settimanali"
else skip residenti "Residenti più pesanti del Mac" "solo il lunedì"; fi
# 6d. Aiutanti che perdono memoria e non muoiono mai (perl di Lyric Fever, WiFiAgent, Ice): riavviati sopra soglia di
#     footprint, solo a Mac fermo. Tampone dichiarato del 25/10: la cura a monte è una scelta di Attilio.
step leaky-helpers "Aiutanti che perdono memoria riavviati" 5 /usr/bin/python3 -I "$HOME/.claude/jarvis/scripts/leaky-helpers/leaky-helpers"
# 6e. Riflessione sulle regole e sui guasti dalle parole di Attilio (29/10: «dovrebbe essere un'unica verifica, dovrebbe
#     già essere attivo il piano di manutenzione»): prima erano due cron OpenClaw (3:30 e 3:50), ora un solo passo che
#     lancia la riflessione, ne controlla l'esito e apre una card per ogni guasto ripetuto. Prima di jarvis-copia e
#     private-backup, così il backup prende il file delle proposte.
step riflessione "Riflessione sulle regole e guasti dalle parole di Attilio" 30 /usr/bin/python3 "$HOME/.claude/jarvis/scripts/riflessione-notte/riflessione-notte"
# 6f. Commit di jarvis che push-guard tiene fuori dal pubblico (26/10: 197 commit solo su questo Mac, 61 dati in
#     tools/usage-hub). Finché la storia non è ripulita, una copia va su un ramo del repo privato.
step jarvis-copia "Copia dei commit di jarvis nel privato" 10 git -C "$HOME/.claude/jarvis" push -q --force https://github.com/zorahrel/jarvis-private.git HEAD:refs/heads/backup/jarvis-public-main
# 7. Backup nel repo privato: per ultimo, così prende anche quello che i passi prima hanno scritto
step private-backup "Backup nel repo privato" 30 /bin/bash "$HOME/.claude/jarvis/private/sync.sh" --commit

exit $FAILED
