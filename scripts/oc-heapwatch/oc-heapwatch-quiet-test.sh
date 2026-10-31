#!/usr/bin/env bash
# Prova la pausa di oc-heapwatch-cont.sh fra le 04:00 e le 06:30 (la finestra dell'update di OpenClaw):
# estrae quiet_left/quiet_wait fra i marcatori e li esegue in zsh con orari scelti.
#   oc-heapwatch-quiet-test.sh                   sullo script vero
#   HEAP_SCRIPT=<copia> oc-heapwatch-quiet-test.sh   su una copia mutata (la usa openclaw-safe-update-mutants.sh)
set -uo pipefail
SCRIPT="${HEAP_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/oc-heapwatch-cont.sh}"
T=$(mktemp -d "${TMPDIR:-/tmp}/heapquiet.XXXXXX"); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; PASS=$((PASS+1)); else echo "  FAIL $1 (atteso '$3', avuto '$2')"; FAIL=$((FAIL+1)); fi; }

sed -n '/# --- quiet-begin/,/# --- quiet-end/p' "$SCRIPT" > "$T/quiet.zsh"
[ -s "$T/quiet.zsh" ] || { echo "  FAIL marcatori quiet-begin/quiet-end assenti in $SCRIPT"; exit 1; }
left() { OC_QUIET_NOW_S=$1 zsh -c "source $T/quiet.zsh; quiet_left"; }
hms() { echo $(( 10#$1 * 3600 + 10#$2 * 60 + 10#$3 )); }

echo "== pausa 04:00-06:30"
check "03:59:59 libero"            "$(left "$(hms 03 59 59)")" 0
check "04:00:00 pausa di 2h30"     "$(left "$(hms 04 00 00)")" 9000
check "05:00:00 mancano 90 min"    "$(left "$(hms 05 00 00)")" 5400
check "06:29:59 manca 1 s"         "$(left "$(hms 06 29 59)")" 1
check "06:30:00 riprende"          "$(left "$(hms 06 30 00)")" 0
check "mezzanotte libero"          "$(left 0)" 0
check "mezzogiorno libero"         "$(left "$(hms 12 00 00)")" 0

# senza OC_QUIET_NOW_S legge l'ora da `date`: 08 e 09 non sono ottali
mkdir -p "$T/bin"
cat > "$T/bin/date" <<'SH'
#!/bin/sh
case "$1" in +%H) echo 05;; +%M) echo 08;; +%S) echo 09;; *) exec /bin/date "$@";; esac
SH
chmod +x "$T/bin/date"
check "orario da date, 05:08:09 (zeri iniziali)" "$(PATH="$T/bin:$PATH" zsh -c "source $T/quiet.zsh; quiet_left")" 4911

echo "== quiet_wait fuori finestra non aspetta"
start=$(date +%s); OC_QUIET_NOW_S=$(hms 12 00 00) zsh -c "source $T/quiet.zsh; quiet_wait"
check "ritorna subito" "$(( $(date +%s) - start < 2 ))" 1

zsh -n "$SCRIPT" && echo "  ok   zsh -n" && PASS=$((PASS+1)) || { echo "  FAIL zsh -n"; FAIL=$((FAIL+1)); }
echo; echo "$PASS ok, $FAIL FAIL"; [ "$FAIL" -eq 0 ]
