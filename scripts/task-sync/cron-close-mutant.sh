#!/bin/sh
# Barra di cron-close: il test esce 0 sul codice vero e 1 su ogni mutante (se un mutante passa, il test non vede il punto).
set -u
D=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d)
node --test "$D/cron-close.test.mjs" >/dev/null 2>&1 || { echo "ROSSO: il test fallisce sul codice vero"; exit 1; }
bad=0
mut() { # nome, da, a
  sed "s|$2|$3|" "$D/cron-close.mjs" > "$T/cron-close.mjs"
  cmp -s "$D/cron-close.mjs" "$T/cron-close.mjs" && { echo "mutante $1: sed non ha cambiato niente"; bad=1; return; }
  if CRON_CLOSE_MODULE="$T/cron-close.mjs" node --test "$D/cron-close.test.mjs" >/dev/null 2>&1; then echo "SOPRAVVISSUTO: $1"; bad=1; else echo "ucciso: $1"; fi
}
mut non-consegnato "r.status === 'ok' \&\& r.delivered \&\&" "r.status === 'ok' \&\&"
mut run-vecchio "r.started_at_ms >= due - 60e3" "r.started_at_ms >= 0"
mut avviso-ripetuto "if (late \&\& !w.alerted)" "if (late)"
mut tutti-i-cron "proofs.length === refs.length" "proofs.length >= 1"
mut cron-sparito-chiude "if (missing \&\& !w.missingAlerted)" "if (false)"
mut ricevuta-orfana "r.job_id.startsWith(ref) \&\&" "jobs.some((j) => j.id === r.job_id) \&\&"
mut avviso-muto "if (notify) await" "if (false) await"
mut registro-ignorato "Math.abs(t - r.started_at_ms) < 60e3" "true"
rm -rf "$T"; exit $bad
