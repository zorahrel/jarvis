#!/usr/bin/env bash
# Mutanti: ognuno rompe UNA regola di group-timeout su una copia, e il banco deve diventare rosso.
# Exit 0 = originale verde e tutti i mutanti rossi.
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/gt-mut.XXXXXX"); trap 'rm -rf "$T"' EXIT
bad=0
"$D/group-timeout-test.sh" > "$T/orig.out" 2>&1 && echo "  ok   originale verde" || { echo "  ERRORE originale rosso"; cat "$T/orig.out"; bad=1; }
mutant() {  # <nome> <sed> [<testo che deve comparire in una riga FAIL: il difetto va preso dal caso giusto>]
  cp "$D/group-timeout" "$T/$1"; chmod +x "$T/$1"; sed -i '' -e "$2" "$T/$1"
  if cmp -s "$D/group-timeout" "$T/$1"; then echo "  ERRORE $1: la mutazione non si applica"; bad=1; return; fi
  if GT_SCRIPT="$T/$1" "$D/group-timeout-test.sh" > "$T/$1.out" 2>&1; then
    echo "  ERRORE $1: il banco e' rimasto VERDE"; bad=1
  elif [ -n "${3:-}" ] && ! grep -q "^  FAIL.*$3" "$T/$1.out"; then
    echo "  ERRORE $1: rosso, ma non dal caso '$3'"; bad=1
  else echo "  ok   $1: rosso ($(grep -c '^  FAIL' "$T/$1.out") FAIL)"; fi
}
# il kill per pid di prima: muore git, il filtro resta appeso
mutant kill-per-pid 's/^  kill TERM => -\$pid;/  kill TERM => $pid;/; s/^  kill KILL => -\$pid;/  kill KILL => $pid;/'
# solo il tetto ferma il pid e non il gruppo: il nipote (git-crypt dietro git) resta vivo con ppid 1
mutant tetto-solo-pid 's/^\$SIG{ALRM} = sub { stop_group();/$SIG{ALRM} = sub { kill TERM => $pid;/' 'nipote: non resta vivo'
# solo i segnali fermano il pid e non il gruppo
mutant segnali-solo-pid 's/\$SIG{\$s} = sub { stop_group();/$SIG{$s} = sub { kill TERM => $pid;/' 'il nipote e. chiuso'
mutant avanzi-lasciati 's/^kill TERM => -\$pid; .*$//'
# niente handler: fermato il job, il passo resta vivo con ppid 1 (verifica del 25/10)
mutant senza-handler-dei-segnali 's/^for my \$s (keys %signo).*$//'
# sempre un gruppo nuovo, anche a mano su un terminale: il passo che legge si ferma su SIGTTIN
mutant terminale-in-sfondo 's/^if (-t STDIN .*$//'
exit $bad
