#!/usr/bin/env bash
# Mutanti: ognuno rompe UNA regola di leaky-helpers su una copia, e il banco deve diventare rosso.
# Exit 0 = originale verde e tutti i mutanti rossi.
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/lh-mut.XXXXXX"); trap 'rm -rf "$T"' EXIT
bad=0
"$D/leaky-helpers-test.sh" > "$T/orig.out" 2>&1 && echo "  ok   originale verde" || { echo "  ERRORE originale rosso"; bad=1; }
mutant() {  # <nome> <sed> [<testo che deve comparire in una riga FAIL: il difetto va preso dal caso giusto>]
  cp "$D/leaky-helpers" "$T/$1"; sed -i '' -e "$2" "$T/$1"
  if cmp -s "$D/leaky-helpers" "$T/$1"; then echo "  ERRORE $1: la mutazione non si applica"; bad=1; return; fi
  if LH_SCRIPT="$T/$1" "$D/leaky-helpers-test.sh" > "$T/$1.out" 2>&1; then
    echo "  ERRORE $1: il banco e' rimasto VERDE"; bad=1
  elif [ -n "${3:-}" ] && ! grep -q "^  FAIL.*$3" "$T/$1.out"; then
    echo "  ERRORE $1: rosso, ma non dal caso '$3'"; bad=1
  else echo "  ok   $1: rosso ($(grep -c '^  FAIL' "$T/$1.out") FAIL)"; fi
}
mutant soglia-lyric-fever-a-3000 's/^LF_LIMIT_MB, WIFI_LIMIT_MB, ICE_LIMIT_MB = 300,/LF_LIMIT_MB, WIFI_LIMIT_MB, ICE_LIMIT_MB = 3000,/'
mutant soglia-compresa 's/p\["fp_mb"\] > LF_LIMIT_MB/p["fp_mb"] >= LF_LIMIT_MB/'
mutant anche-il-perl-di-wispr 's|and "/Lyric Fever.app/" in cmd ||'
mutant niente-mac-libero 's/if run(\[MAC_LIBERO\], 10)\[0\] != 0:/if False:/'
mutant footprint-in-kb 's/r.phys_footprint >> 20/r.phys_footprint >> 10/'
# misura il residente (RSS) invece del footprint: coincidono sulla memoria anonima, divergono sui file mappati
mutant footprint-e-il-residente 's/r.phys_footprint >> 20/r.resident_size >> 20/' 'footprint_mb .* MB: il residente'
mutant errore-di-osascript-buttato 's/^        log(f"{name}: osascript exit {rc}.*$/        pass/'
exit $bad
