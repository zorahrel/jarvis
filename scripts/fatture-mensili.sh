#!/usr/bin/env bash
# fatture-mensili.sh [YYYY-MM] [--invia] — raccolta mensile fatture servizi ricorrenti Armonia.
# Motore in fatture-mensili.py. Senza --invia non spedisce nulla.
# Cron previsto (mese precedente): fatture-mensili.sh "$(date -v-1m +%Y-%m)" --invia
exec python3 -I "$(cd "$(dirname "$0")" && pwd)/fatture-mensili.py" "$@"
