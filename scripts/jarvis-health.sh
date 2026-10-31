#!/usr/bin/env bash
#
# jarvis-health.sh — probe dello stato di Jarvis, con exit code.
#
# Perche' esiste: i check vivevano come bash sparso dentro il prompt di
# morning-check. Se un probe si rompeva non falliva un processo, falliva la
# frase che il modello scriveva — e infatti il 07/08/2026 l'audit ha trovato
# tre check bugiardi, tra cui uno (Docker) che non poteva fallire per
# costruzione: `2>/dev/null` mangiava l'errore, l'output vuoto passava, e il
# template stampava "Docker: OK" su un daemon inesistente.
#
# Regola di questo file: ogni probe distingue quattro stati e nessuno di essi
# e' il silenzio.
#   OK    verde
#   WARN  degradato ma non guasto        -> non cambia l'exit code
#   FAIL  guasto                         -> exit 1
#   SKIP  assente per scelta, non rotto  -> non cambia l'exit code
#
# Uso:
#   jarvis-health.sh            report leggibile, exit 0/1
#   jarvis-health.sh --quiet    stampa solo WARN/FAIL
#
set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

FAILS=0
WARNS=0

# --- reporter ---------------------------------------------------------------
ok()   { (( QUIET )) || printf '  OK    %-14s %s\n' "$1" "${2:-}"; }
warn() { WARNS=$((WARNS+1)); printf '  WARN  %-14s %s\n' "$1" "${2:-}"; }
fail() { FAILS=$((FAILS+1)); printf '  FAIL  %-14s %s\n' "$1" "${2:-}"; }
skip() { (( QUIET )) || printf '  SKIP  %-14s %s\n' "$1" "${2:-}"; }
section() { (( QUIET )) || printf '\n%s\n' "$1"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# il router (:3340) e' stato ritirato il 18/10: la dashboard viva e' il hub dell'uso su :3360
HUB=http://127.0.0.1:3360

# --- disco ------------------------------------------------------------------
section "Disco"
avail_gb=$(df -g / | awk 'NR==2 {print $4}')
if [[ -z "$avail_gb" ]]; then
  fail disco "df non ha restituito nulla"
elif (( avail_gb < 20 )); then
  fail disco "${avail_gb}G liberi (soglia 20G)"
elif (( avail_gb < 50 )); then
  warn disco "${avail_gb}G liberi (soglia 50G)"
else
  ok disco "${avail_gb}G liberi"
fi

# --- docker -----------------------------------------------------------------
# Tre esiti distinti. "Non installato" e "daemon spento" NON sono guasti:
# Docker.app e' stato cestinato di proposito il 19/07/2026.
section "Docker"
if ! command -v docker >/dev/null 2>&1; then
  skip docker "non installato"
elif ! docker info >/dev/null 2>&1; then
  skip docker "installato ma daemon spento (atteso dal 19/07/2026)"
else
  reclaim=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1)
  gb=$(printf '%s' "${reclaim:-0}" | grep -oE '^[0-9.]+' || echo 0)
  if awk "BEGIN{exit !(${gb:-0} > 5)}"; then
    warn docker "${reclaim} recuperabili — docker image prune -a --filter 'until=720h' -f"
  else
    ok docker "${reclaim:-0} recuperabili"
  fi
fi

# --- cache dev --------------------------------------------------------------
section "Cache"
check_cache() { # nome, path, soglia MB
  [[ -d "$2" ]] || { skip "$1" "assente"; return; }
  local mb; mb=$(du -sm "$2" 2>/dev/null | awk '{print $1}')
  if [[ -n "$mb" ]] && (( mb > $3 )); then
    warn "$1" "${mb}MB (soglia ${3}MB)"
  else
    ok "$1" "${mb:-0}MB"
  fi
}
check_cache npm  "$HOME/.npm/_cacache"        500
check_cache bun  "$HOME/.bun/install/cache"   500
check_cache brew "$(brew --cache 2>/dev/null || echo /nonexistent)" 200

# --- servizi ----------------------------------------------------------------
# :3342 e' docs-index (docs-server.py, sqlite+numpy). NON e' piu' ChromaDB dal
# 05/07/2026 e non risponde su /api/v2/heartbeat — il vecchio probe stampava
# un rosso falso ogni mattina da un mese.
section "Servizi"
probe() { # nome, url, [timeout s]
  # lento non e' spento: oltre il timeout (curl 28) e' WARN, solo connessione rifiutata o errore HTTP e' FAIL.
  # Il 26/10 alle 00:55, a carico 75, il summary dell'hub a freddo ha passato i 20 s (subito dopo: 7,5 s, poi 0,01 s in cache).
  curl -sf --max-time "${3:-5}" "$2" >/dev/null 2>&1
  case $? in
    0)  ok "$1" "$2" ;;
    28) warn "$1" "acceso ma lento: oltre ${3:-5} s su $2" ;;
    *)  fail "$1" "non risponde su $2" ;;
  esac
}
# summary dell'hub puo' metterci oltre 5 s a freddo: stesso -m 20 di brief-mattutino.sh
probe usage-hub  "$HUB/api/automations/summary" 20
# docs-index parte a richiesta (launchd Sockets, esce dopo 15 min fermo): alle 07:30 e' a freddo e carica numpy, 5 s non bastano a Mac carico (card 148823c7)
probe docs-index "http://127.0.0.1:3342/health" 20

# --- cron -------------------------------------------------------------------
# Il vecchio check guardava solo consecutiveErrors>2: un cron che smette di
# partire ha errori a zero e lastRun vecchio, quindi era invisibile. Qui la
# staleness si misura contro il periodo dedotto dallo schedule.
# Dal 29/09/2026 i cron stanno in OpenClaw: il router e' solo dashboard.
section "Cron"
cron_out=$(perl -e 'alarm 30; exec @ARGV' openclaw cron list --json 2>/dev/null | python3 "$HERE/health/cron.py" 2>&1)

if [[ -z "$cron_out" ]]; then
  fail cron "OpenClaw non ha risposto a 'openclaw cron list --json'"
else
  while IFS='|' read -r state name msg; do
    case "$state" in
      OK)   ok   "$name" "$msg" ;;
      WARN) warn "$name" "$msg" ;;
      FAIL) fail "$name" "$msg" ;;
      SKIP) skip "$name" "$msg" ;;
    esac
  done <<< "$cron_out"
fi

# --- canali -----------------------------------------------------------------
# Dal 18/10 il router non serve piu' WhatsApp: lo stato dei canali (Discord, Telegram,
# WhatsApp) lo dice il gateway OpenClaw. Il vecchio probe sul router dava FAIL ogni mattina.
section "Canali"
ch_out=$(perl -e 'alarm 30; exec @ARGV' openclaw channels status --json 2>/dev/null | python3 "$HERE/health/channels.py" 2>&1)
if [[ -z "$ch_out" ]]; then
  fail canali "OpenClaw non ha risposto a 'openclaw channels status --json'"
else
  while IFS='|' read -r state name msg; do
    case "$state" in
      OK)   ok   "$name" "$msg" ;;
      WARN) warn "$name" "$msg" ;;
      FAIL) fail "$name" "$msg" ;;
      SKIP) skip "$name" "$msg" ;;
    esac
  done <<< "$ch_out"
fi

# --- agenti e Mac -----------------------------------------------------------
# agents-doctor (hub skill/regole/MCP): i suoi rossi sono WARN qui, non guasti del sistema.
# mac-health non si rilancia (il sondaggio degli elementi d'avvio dura minuti e ha i suoi cron):
# si guarda solo l'eta' dell'ultimo rapporto.
section "Agenti e Mac"
if command -v agents-doctor >/dev/null 2>&1; then
  ad_out=$(perl -e 'alarm 60; exec @ARGV' agents-doctor 2>&1)
  ad_rc=$?
  ad_red=$(printf '%s\n' "$ad_out" | /usr/bin/grep '^FAIL' | sed 's/^FAIL *//' | cut -c1-70 | paste -sd';' -)
  if [[ $ad_rc -eq 142 || $ad_rc -eq 14 ]]; then
    warn agents-doctor "non ha finito entro 60 s"
  elif [[ -n "$ad_red" ]]; then
    warn agents-doctor "$ad_red"
  else
    ok agents-doctor "nessun controllo rosso"
  fi
else
  skip agents-doctor "non installato"
fi
last_mh=$(ls -t "$HOME/.claude/jarvis/logs/mac-health/"*.md 2>/dev/null | head -1)
if [[ -z "$last_mh" ]]; then
  skip mac-health "nessun rapporto ancora"
else
  mh_days=$(( ( $(date +%s) - $(stat -f %m "$last_mh") ) / 86400 ))
  if (( mh_days > 9 )); then warn mac-health "ultimo rapporto di ${mh_days} giorni fa (atteso ogni 7)"; else ok mac-health "ultimo rapporto ${mh_days}g fa"; fi
fi

# --- esito ------------------------------------------------------------------
printf '\n'
if (( FAILS > 0 )); then
  (( FAILS == 1 )) && noun=guasto || noun=guasti
  printf '%d %s, %d warning\n' "$FAILS" "$noun" "$WARNS"
  exit 1
fi
printf 'tutto verde (%d warning)\n' "$WARNS"
exit 0
