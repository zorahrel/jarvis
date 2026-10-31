#!/bin/bash
# Riprende una sessione Claude Code desktop ferma sul limite settimanale, dopo il reset quota.
# Uso: riprendi-claude-dopo-reset.sh <session-id> <account-grep> <reset-epoch> <deadline-epoch> "<nudge>"
#   1. aspetta che la quota dell'account torni (usage-hub pace), fino alla deadline
#   2. se il transcript si è già mosso da solo dopo il reset, esce senza fare niente
#   3. altrimenti `claude -p --resume` col nudge; log completo su file, in stdout solo la coda.
# --dry-run: controlla quota e stato e stampa il comando, senza eseguire claude.
H=~
DRY=0
[ "$1" = "--dry-run" ] && { DRY=1; shift; }
SID="$1"; ACCT="$2"; RESET="$3"; DEADLINE="$4"; NUDGE="$5"
[ -z "$SID" ] || [ -z "$ACCT" ] || [ -z "$RESET" ] || [ -z "$DEADLINE" ] || [ -z "$NUDGE" ] && {
  echo "uso: $0 [--dry-run] <session-id> <account-grep> <reset-epoch> <deadline-epoch> \"<nudge>\""; exit 2; }
F=$(ls $H/.claude/projects/*/"$SID".jsonl 2>/dev/null | head -n 1)
[ -f "$F" ] || { echo "transcript non trovato per $SID"; exit 2; }
PACE="$H/.claude/jarvis/tools/usage-hub/bin/usage-hub.mjs"
# Metadati desktop: il file si chiama col suo id della app, che spesso non è quello del transcript (cliSessionId).
META=$(ls $H/Library/Application\ Support/Claude/claude-code-sessions/*/*/local_"$SID".json 2>/dev/null | head -n 1)
[ -f "$META" ] || META=$(/usr/bin/grep -l "\"cliSessionId\": *\"$SID\"" $H/Library/Application\ Support/Claude/claude-code-sessions/*/*/local_*.json 2>/dev/null \
  | xargs -I{} stat -f '%m {}' {} 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)
# Cron recuperato in ritardo (28/10: scheduler OpenClaw fermo dalle 04:20, il giro delle 05:00 è partito alle 11:52):
# oltre la deadline Attilio ha già ripreso a mano altrove, rilanciare vuol dire fare due volte lo stesso lavoro.
[ "$(date +%s)" -gt "$DEADLINE" ] && { echo "oltre la deadline ($(date -r "$DEADLINE" '+%d/%m %H:%M')), non riprendo"; exit 0; }
# Sessione archiviata nella app = chiusa da Attilio (o sostituita da un'altra): non si riprende.
[ -f "$META" ] && /usr/bin/python3 -c "import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get('isArchived') else 1)" "$META" \
  && { echo "sessione archiviata nella app, non riprendo"; exit 0; }

quota_ok() { # 0 = quota tornata
  LINE=$(node "$PACE" pace 2>/dev/null | grep "$ACCT" | head -n 1)
  [ -z "$LINE" ] && return 1
  echo "$LINE" | grep -q "esaurito" && return 1 || return 0
}
if quota_ok; then echo "quota $ACCT: ok subito"; else
  echo "quota $ACCT: ancora esaurita, attendo fino a $(date -r "$DEADLINE" '+%H:%M')"
  [ "$DRY" = 1 ] && echo "DRY-RUN: salto l'attesa (in produzione dormo 5 min a giro)"
  if [ "$DRY" = 0 ]; then
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
      sleep 300
      quota_ok && break
    done
    quota_ok || { echo "quota ancora esaurita alla deadline, rinuncio"; exit 3; }
    echo "quota $ACCT: tornata alle $(date '+%H:%M')"
  fi
fi
# Già ripartita da sola (o a mano) dopo il reset? Ultimi byte senza errore di limite + file mosso.
MT=$(stat -f %m "$F")
if [ "$MT" -gt "$RESET" ] && ! tail -c 4000 "$F" | grep -qi "weekly limit\|usage limit\|limit.*reset"; then
  echo "transcript già ripartito dopo il reset (mtime $(date -r "$MT" '+%H:%M')), non faccio niente"
  exit 0
fi
# Cartella di lavoro dai metadati desktop, se presenti.
CWD=""
[ -f "$META" ] && CWD=$(/usr/bin/python3 -c "import json;print(json.load(open('$META')).get('cwd',''))" 2>/dev/null)
[ -n "$CWD" ] && [ -d "$CWD" ] && cd "$CWD" || cd "$H" || exit 2
LOG="$H/.claude/jarvis/logs/ripresa-$SID-$(date '+%H%M').log"
CMD="claude -p --resume $SID --permission-mode auto --effort medium --model claude-opus-5-5"
if [ "$DRY" = 1 ]; then echo "DRY-RUN: ($PWD) $CMD \"<nudge>\" > $LOG 2>&1"; exit 0; fi
echo "riprendo $SID alle $(date '+%H:%M') da $PWD, log $LOG"
$CMD "$NUDGE" >"$LOG" 2>&1; RC=$?
echo "--- coda del log (exit $RC) ---"; tail -n 25 "$LOG"; echo "log completo: $LOG"
exit $RC
