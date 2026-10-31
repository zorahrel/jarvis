#!/usr/bin/env bash
# Barra del sonno del PC (wf-autosleep, in ~/Projects/winfleet/host). exit 0 = tutto verde.
#   1. PC fermo -> dorme fra soglia e soglia+3 min (ne' prima ne' mai)   2. winwake -> ssh di nuovo su
#   3. un job di offload piu' lungo della soglia arriva in fondo (il PC non dorme mentre lavora)
# Per non aspettare 20 minuti la soglia scende a PC_SLEEP_TEST_MIN (2) e a fine giro torna 20.
#   pc-sleep-test.sh --mutate   toglie il controllo sulle sessioni ssh e rifa' il punto 3:
#                               esce 0 se la barra diventa rossa (la mutazione morde).
# ~15 minuti: lanciala in background. Durante il punto 1 non toccare il PC via ssh.
set -u
# Dati del PC: solo da ~/.config/winfleet/config.env (fuori da ogni repo). Se il file o la variabile
# mancano si esce con 3 e un messaggio, invece di proseguire con un host vuoto.
wfconf() {
  local v; v="$(set +eu; . "$HOME/.config/winfleet/config.env" >/dev/null 2>&1; printf '%s' "${!1:-}")"
  [ -n "$v" ] || { echo "${0##*/}: manca $1 in ~/.config/winfleet/config.env" >&2; return 3; }
  printf '%s' "$v"
}
HOST="$(wfconf HOST_SSH)" || exit 3
IP="${HOST#*@}"; MIN="${PC_SLEEP_TEST_MIN:-2}"
SRC="$HOME/Projects/winfleet/host/wf-autosleep.ps1"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=5)
F=0; ok() { echo "ok   $1"; }; ko() { echo "FAIL $1"; F=1; }
up() { nc -z -G 3 "$IP" 22 2>/dev/null; }   # solo TCP: una sessione ssh conterebbe come lavoro
wake() { up || ~/.local/bin/winwake >/dev/null 2>&1; up; }
logtail() { "${SSH[@]}" "$HOST" "powershell -NoProfile -Command \"Get-Content C:\\winfleet\\autosleep.log -Tail ${1:-6}\"" 2>/dev/null | sed 's/^/     /'; }

T=$(mktemp -d); echo x > "$T/x.txt"
N="$(basename "$T" | tr -c 'A-Za-z0-9_-' '_')_$(printf %s "$T" | shasum | cut -c1-6)"
restore() {
  wake >/dev/null
  scp -q -o BatchMode=yes "$SRC" "$HOST:C:/winfleet/wf-autosleep.ps1"
  "${SSH[@]}" "$HOST" "del C:\\winfleet\\autosleep.minutes 2>nul & rmdir /s /q E:\\offload\\$N 2>nul" >/dev/null 2>&1
  rm -rf "$T"
}
trap restore EXIT

job() {  # ping che non usa CPU: tiene sveglio il PC solo il controllo sulla sessione ssh
  local secs=$(( (MIN + 3) * 60 )) out rc
  out=$(offload --pc -C "$T" -- "ping -n $secs 127.0.0.1 >nul && echo JOB-FINITO" 2>/dev/null); rc=$?
  [ $rc = 0 ] && printf %s "$out" | grep -q JOB-FINITO
}

wake || { echo "FAIL PC non raggiungibile"; exit 1; }
# soglia corta, e conteggio da zero: senza togliere lo stato il punto 1 misurerebbe un'inattivita'
# cominciata prima della barra. La redirezione va davanti: in cmd `echo 2> file` e' "stderr nel
# file", il file restava vuoto e il primo giro della barra ha provato una soglia di 0 minuti.
"${SSH[@]}" "$HOST" ">C:\\winfleet\\autosleep.minutes echo $MIN& del C:\\winfleet\\autosleep.state 2>nul" >/dev/null || { echo "FAIL non scrivo la soglia"; exit 1; }
"${SSH[@]}" "$HOST" "type C:\\winfleet\\autosleep.minutes" 2>/dev/null | tr -d '\r ' | grep -qx "$MIN" || { echo "FAIL la soglia sul PC non e' $MIN"; exit 1; }

if [ "${1:-}" = --mutate ]; then
  sed '/ssh attivo/d' "$SRC" > "$T/mutante.ps1"
  ! grep -q 'ssh attivo' "$T/mutante.ps1" || { echo "FAIL mutazione non applicata"; exit 1; }
  scp -q -o BatchMode=yes "$T/mutante.ps1" "$HOST:C:/winfleet/wf-autosleep.ps1"
  if job; then echo "FAIL mutazione sopravvissuta: senza il controllo ssh il job arriva in fondo"; exit 1; fi
  echo "ok   mutazione morde: senza il controllo ssh il PC dorme durante il job"; logtail 4; exit 0
fi

# 1. fermo -> dorme. Si guarda solo la porta, ogni 10 s.
t0=$(date +%s); lim=$(( (MIN + 3) * 60 ))
while up && [ $(( $(date +%s) - t0 )) -lt $lim ]; do sleep 10; done
dt=$(( $(date +%s) - t0 ))
if up; then ko "fermo da $((lim / 60)) min ma ancora acceso"; logtail
elif [ $dt -lt $(( MIN * 60 - 30 )) ]; then ko "dorme dopo $dt s, prima della soglia di $MIN min"
else ok "fermo -> dorme dopo $dt s (soglia $MIN min)"; fi

# 2. winwake -> ssh
t0=$(date +%s)
if wake && "${SSH[@]}" "$HOST" exit; then ok "winwake -> ssh in $(( $(date +%s) - t0 )) s"; else ko "winwake: ssh non torna"; fi

# 3. job piu' lungo della soglia
t0=$(date +%s)
if job; then ok "job di $(( MIN + 3 )) min (soglia $MIN) arrivato in fondo in $(( $(date +%s) - t0 )) s"; else ko "job interrotto dopo $(( $(date +%s) - t0 )) s"; logtail; fi
exit $F
