#!/usr/bin/env bash
# Barra della coda di offload sul Mac (senza PC): cartella dei posti, stato del Mac e registro del freno finti, comandi
# brevi che finiscono da soli (sleep). exit 0 = tutto verde.
#   bash ~/bin/offload-slot-test.sh          OFFLOAD_BIN=<copia> per i mutanti (usage-hub test/mutants-brake.sh)
set -u
OFF="${OFFLOAD_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/offload}"
T=$(mktemp -d); mkdir -p "$T/repo" "$T/slots"
cleanup() { jobs -p | xargs kill 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
unset TOPICS_GATE_HELD OFFLOAD_WHO
export TOPICS_GATE_SLOT_DIR="$T/slots" TOPICS_GATE_SLOTS=3 OFFLOAD_CACHE="$T/cache" OFFLOAD_STATE_FILE="$T/state.json" \
  OFFLOAD_BRAKE_LOG="$T/brake.jsonl" MAC_ATTENTION_BIN=/nonexistent OFFLOAD_POLL=1 OFFLOAD_WAIT=30 OFFLOAD_HOST=nobody@192.0.2.1 OFFLOAD_FAKE_LOAD=0.20
F=0; N=0
ok() { N=$((N + 1)); }
ko() { echo "FAIL $1"; F=1; }
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
calm() { echo "{\"at\":$(date +%s)000,\"strained\":false}" > "$T/state.json"; }
strained() { echo "{\"at\":$(date +%s)000,\"strained\":true}" > "$T/state.json"; }
held() { ls "$T/slots" | grep -cE '^[0-9]+\.pid$'; }
clear_slots() { rm -f "$T/slots"/*.pid; }
off() { MAC_ATTENTION="$1" "$OFF" -C "$T/repo" --local -- "${@:2}"; }   # off <attenzione> <comando>
wait_held() { local i; for ((i = 0; i < 50; i++)); do [ "$(held)" -ge "$1" ] && return 0; sleep 0.1; done; return 1; }
calm

# 1. tre giri in background prendono i 3 posti, il quarto aspetta e poi parte; mai più di 3 file vivi
for i in 1 2 3; do (off background 'sleep 3' >/dev/null 2>&1 &); done
wait_held 3 || ko "i tre giri non hanno preso i posti ($(held))"
max=0; ( for i in $(seq 1 40); do h=$(held); echo "$h"; sleep 0.1; done > "$T/samples" ) &
sampler=$!
t0=$(now); out=$(OFFLOAD_WAIT=20 off background 'echo quarto' 2>"$T/err4"); rc=$?; t1=$(now)
wait $sampler 2>/dev/null
max=$(sort -n "$T/samples" | tail -1)
if [ "$rc" = 0 ] && [ "$out" = quarto ] && grep -q 'in coda' "$T/err4" && perl -e "exit !($t1 - $t0 >= 1)"; then ok; else ko "a 4th background run waits and then runs (rc $rc, out '$out', $(perl -e "printf '%.1f', $t1 - $t0") s)"; fi
[ "${max:-9}" -le 3 ] && ok || ko "never more than 3 live <i>.pid files (visti $max)"
sleep 0.5; clear_slots

# 2. posti tutti presi da vivi: OFFLOAD_WAIT=2 → exit 75, il comando non parte
for i in 0 1 2; do echo $$ > "$T/slots/$i.pid"; done
OFFLOAD_WAIT=2 off background "touch $T/partito" 2>"$T/err"; rc=$?
if [ "$rc" = 75 ] && grep -q 'NON è partito' "$T/err" && [ ! -e "$T/partito" ]; then ok; else ko "OFFLOAD_WAIT=2 gives exit 75 plus the message (rc $rc)"; fi

# 3. chi ha qualcuno davanti non aspetta mai
t0=$(now); OFFLOAD_WAIT=3 off human true 2>"$T/err"; rc=$?; t1=$(now)
if [ "$rc" = 0 ] && perl -e "exit !($t1 - $t0 < 1)"; then ok; else ko "human runs in < 1 s with all slots busy (rc $rc, $(perl -e "printf '%.2f', $t1 - $t0") s)"; fi
OFFLOAD_WAIT=1 off delegated true 2>/dev/null; [ $? = 0 ] && ok || ko 'delegated non aspetta'
clear_slots

# 4. Mac sotto sforzo: in background si aspetta anche coi posti liberi
strained; OFFLOAD_WAIT=1 off background true 2>/dev/null; rc=$?; calm
[ "$rc" = 75 ] && ok || ko "strained state: background waits even with free slots (rc $rc)"

# 4b. carico vivo oltre 1,5 per core con il hub «tranquillo»: in background si aspetta lo stesso (il hub non sostituisce il carico)
OFFLOAD_FAKE_LOAD=2.10 OFFLOAD_WAIT=1 off background true 2>/dev/null; rc=$?
[ "$rc" = 75 ] && ok || ko "live load above 1.5 with a calm hub state: background waits (rc $rc)"
OFFLOAD_FAKE_LOAD=1.40 OFFLOAD_WAIT=1 off background true 2>/dev/null; rc=$?
[ "$rc" = 0 ] && ok || ko "live load below 1.5 and calm hub: background runs (rc $rc)"
OFFLOAD_FAKE_LOAD=2.10 OFFLOAD_WAIT=1 off human true 2>/dev/null; [ $? = 0 ] && ok || ko 'human non aspetta nemmeno a carico alto'

# 5. posto di un morto: si libera; posto vuoto: vivo (pid 0, come reapStale)
sleep 0 & dead=$!; wait $dead
for i in 0 1 2; do echo $dead > "$T/slots/$i.pid"; done
OFFLOAD_WAIT=2 off background true 2>/dev/null; rc=$?
if [ "$rc" = 0 ] && [ "$(held)" = 0 ]; then ok; else ko "dead-pid <i>.pid is reaped (rc $rc, rimasti $(held))"; fi
for i in 0 1 2; do : > "$T/slots/$i.pid"; done
OFFLOAD_WAIT=1 off background true 2>/dev/null; [ $? = 75 ] && ok || ko 'empty <i>.pid counts as a live holder'
clear_slots

# 6. il figlio sa di stare dentro un posto; un giro annidato non ne prende un altro
o=$(off background 'echo "$TOPICS_GATE_HELD"' 2>/dev/null); [ "$o" = offload ] && ok || ko "child sees TOPICS_GATE_HELD ('$o')"
for i in 0 1 2; do echo $$ > "$T/slots/$i.pid"; done
TOPICS_GATE_HELD=1 OFFLOAD_WAIT=1 off background true 2>/dev/null; [ $? = 0 ] && ok || ko 'nested run inside a held slot does not queue'
clear_slots

# 7. exit code del comando: 75 compreso, senza confonderlo con la coda
off background 'exit 75' 2>"$T/err"; rc=$?
if [ "$rc" = 75 ] && ! grep -q 'NON è partito' "$T/err" && grep -q 'exit 75' "$T/err"; then ok; else ko "a command that exits 75 is reported as 75 (rc $rc)"; fi
off human 'exit 3' 2>/dev/null; [ $? = 3 ] && ok || ko 'exit code passato'
[ "$(held)" = 0 ] && ok || ko "posto rilasciato a fine giro ($(held))"

# 8. il giro in corso si vede (running/<pid>.json) e il posto torna libero anche se lo chiudono
(off background 'sleep 3' >/dev/null 2>&1 &)
wait_held 1; sleep 0.3
r=$(cat "$T/cache/running/"*.json 2>/dev/null | jq -r '"\(.local) \(.slot)"' 2>/dev/null | head -1)
[ "$r" = 'true 0' ] && ok || ko "running/<pid>.json has local:true and the slot ('$r')"
holder=$(cat "$T/slots/0.pid" 2>/dev/null)
[ -n "$holder" ] && kill -TERM "$holder" 2>/dev/null
for i in $(seq 1 40); do [ "$(held)" = 0 ] && break; sleep 0.1; done
[ "$(held)" = 0 ] && ok || ko 'TERM a offload: posto rilasciato'
sleep 0.2; ls "$T/cache/running/"*.json >/dev/null 2>&1 && ko 'running/<pid>.json rimasto dopo TERM' || ok

# 9. nota del freno: un'azione sul ramo di questo giro (qui: questo test, antenato di offload)
off background "echo '{\"at\":'\$(date +%s)'000,\"pid\":$$,\"action\":\"stop\",\"why\":\"fuori coda col Mac a 3,4 per core\"}' >> $T/brake.jsonl" 2>"$T/err"
grep -q 'il freno del Mac ha fermato questo giro' "$T/err" && grep -q 'fuori coda' "$T/err" && ok || ko "ledger fixture produces the note: $(tail -2 "$T/err")"
sleep 1.1; off background true 2>"$T/err"; grep -q 'freno' "$T/err" && ko 'nota del freno su un giro che non è stato toccato' || ok

# 10. interop: gate-slot.ts di Topics vede i posti presi da offload
GS="${TOPICS_APP:-$HOME/Projects/topics-app}/scripts/gate-slot.ts"
if command -v bun >/dev/null && [ -f "$GS" ]; then
  for i in 1 2 3; do (off background 'sleep 3' >/dev/null 2>&1 &); done
  wait_held 3
  p=$(bun -e "import { acquireSlot } from '$GS'; const r = acquireSlot(3, 'probe', { maxWaitMs: 0, onWait: () => {} }); console.log(r === null ? 'busy' : 'free'); if (r) r();" 2>/dev/null)
  [ "$p" = busy ] && ok || ko "interop: gate-slot.ts acquireSlot sees offload's slots as busy ('$p')"
  sleep 3.5; clear_slots
  r=$(bun -e "import { acquireSlot } from '$GS'; const r = acquireSlot(3, 'probe', { maxWaitMs: 0, onWait: () => {} }); console.log(r === null ? 'busy' : 'free'); if (r) r();" 2>/dev/null)
  [ "$r" = free ] && ok || ko "interop: a posti liberi gate-slot.ts ne prende uno ('$r')"
else
  echo "interop skipped (manca bun o $GS)"
fi

echo "$N ok"
exit $F
