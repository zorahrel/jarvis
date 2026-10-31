#!/bin/sh
# Barra della regola «review di Attilio»: il test esce 0 sul codice vero e 1 su ogni mutante che rimette il vecchio comportamento
# (se un mutante passa, il test non vede il punto). uso: sh scripts/task-sync/task-sync-mutant.sh
set -u
D=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d)
node --test "$D/task-sync.mia.test.mjs" >/dev/null 2>&1 || { echo "ROSSO: il test fallisce sul codice vero"; exit 1; }
bad=0
mut() { # nome, da, a (sed, `&` da proteggere)
  sed "s#$2#$3#" "$D/task-sync.mjs" > "$T/task-sync.mjs" || { echo "mutante $1: sed fallito"; bad=1; return; }
  cp "$D/diario.mjs" "$T/diario.mjs"
  cmp -s "$D/task-sync.mjs" "$T/task-sync.mjs" && { echo "mutante $1: sed non ha cambiato niente"; bad=1; return; }
  if TASK_SYNC_MODULE="$T/task-sync.mjs" node --test "$D/task-sync.mia.test.mjs" >/dev/null 2>&1; then echo "SOPRAVVISSUTO: $1"; bad=1; else echo "ucciso: $1"; fi
}
mut ogni-review-e-sua "export const isMine = (text) => ASK.test(text || '') || FROM_REM.test(text || '');" "export const isMine = () => true;"
mut review-muta-in-in-corso "export const seenCls = (c) => (c.cls === 'review' \&\& !c.mine ? 'in_progress' : c.cls);" "export const seenCls = (c) => c.cls;"
mut completare-approva-sempre "const remClosedNow = !quiet \&\& r.done" "const remClosedNow = r.done"
mut voce-vecchia-ritoccata "if (quiet) { /\* la voce resta" "if (false) { /* la voce resta"
mut altre-board-sempre-sul-telefono "c.cls === 'review' \&\& c.mine ? 'review' : null" "c.cls === 'review' ? 'review' : null"
mut diario-a-ogni-giro "const fresh = silenti.filter((c) => !noted\[c.id\]);" "const fresh = silenti;"
mut base-resta-review-da-quieta "cls = quiet ? cc : remClosedNow" "cls = remClosedNow"
mut messaggio-senza-domanda "\${c.ask ? \`" "\${false ? \`"
rm -rf "$T"; exit $bad
