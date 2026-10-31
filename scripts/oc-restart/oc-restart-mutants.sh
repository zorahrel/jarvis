#!/bin/sh
# Barra di oc-restart-test.py: il test deve passare sul file vero e diventare rosso su ogni mutante
# che toglie l'eta' da una delle tre fonti (sottoagenti, cron, chat) o rimette la vecchia riga unica.
# Esce 0 solo se il vero e' verde e TUTTI i mutanti sono rossi; altrimenti 1 e dice quale.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
bad=0

python3 "$DIR/oc-restart-test.py" >"$TMP/real.out" 2>&1 || { echo "ROSSO: il test fallisce sul file vero"; tail -5 "$TMP/real.out"; exit 1; }
echo "vero: verde"

mutant() { # nome, vecchio, nuovo
  python3 - "$DIR/oc-restart" "$TMP/$1" "$2" "$3" <<'PY' || { echo "ROSSO: il mutante $1 non si applica (frammento sparito)"; bad=1; return; }
import sys
src, out, old, new = sys.argv[1:5]
s = open(src).read()
if s.count(old) != 1:
    sys.exit(1)
open(out, "w").write(s.replace(old, new))
PY
  [ -f "$TMP/$1" ] || return
  if OC_RESTART_SRC="$TMP/$1" python3 "$DIR/oc-restart-test.py" >"$TMP/$1.out" 2>&1; then
    echo "ROSSO: il mutante $1 passa (la barra non lo vede)"; bad=1
  else
    echo "mutante $1: rosso ($(grep -c FAIL "$TMP/$1.out") FAIL)"
  fi
}

mutant chat 'f"{s['"'"'key'"'"']} (aggiornata {age_text(s['"'"'ageMs'"'"'])} fa)" if s.get("ageMs") is not None else s["key"]' 's["key"]'
mutant sottoagente 'return f"{label} (da {age_text(now_ms - started)})" if started else label' 'return label'
mutant cron 'out.append(("cron", f"{job[:8]} (da {age_text(now_ms - started)})"))' 'out.append(("cron", job[:8]))'
mutant elenco 'print(f"{len(busy)} cose in corso" + (":" if busy else ": nessuna"))
        for k, v in busy:
            print(f"  - {k}: {v}")' 'print(f"{len(busy)} cose in corso: " + (", ".join(f"{k} {v}" for k, v in busy) or "nessuna"))'
exit $bad
