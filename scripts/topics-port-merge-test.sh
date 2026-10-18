#!/bin/bash
# Barra di topics-port-merge.sh, su un repo finto in /tmp (mai il vivo). Il merge modifica uno
# script eseguibile, ne aggiunge uno, toglie un file e aggiunge uno script a package.json, nel
# vivo indietro di versione come dopo gli auto-bump di main. Uso: topics-port-merge-test.sh [script]
set -u
S="${1:-$(dirname "$0")/topics-port-merge.sh}"; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git init -q "$T/origin" && cd "$T/origin" && git config user.email t@t && git config user.name t
printf 'v1\n' > a.sh && chmod +x a.sh && printf 'gone\n' > b.txt
printf '{\n  "name": "x",\n  "version": "1.0.1",\n  "scripts": {\n    "a": "a"\n  }\n}\n' > package.json
git add -A && git commit -qm base
git clone -q "$T/origin" "$T/live"
printf 'v2\n' > a.sh && git rm -q b.txt && printf 'new\n' > c.sh && chmod +x c.sh
printf '{\n  "name": "x",\n  "version": "1.0.1",\n  "scripts": {\n    "a": "a",\n    "b": "b"\n  }\n}\n' > package.json
git add -A && git commit -qm merge
M=$(git rev-parse HEAD); cd "$T/live" && git fetch -q origin
perl -pi -e 's/"version": "1.0.1"/"version": "1.0.0"/' package.json
TOPICS_LIVE="$T/live" bash "$S" "$M" --apply > "$T/out" 2>&1; rc=$?
ok=1
[ "$rc" -eq 0 ] || { echo "rc=$rc"; ok=0; }
[ "$(cat a.sh)" = v2 ] && [ -x a.sh ] || { echo "a.sh: contenuto o modo sbagliato ($(stat -f %Lp a.sh))"; ok=0; }
[ -x c.sh ] || { echo "c.sh: non eseguibile ($(stat -f %Lp c.sh 2>/dev/null))"; ok=0; }
[ ! -e b.txt ] || { echo "b.txt: ancora nel vivo"; ok=0; }
grep -q '"version": "1.0.0"' package.json && grep -q '"b": "b"' package.json \
  || { echo "package.json: versione del vivo persa o script nuovo mancante"; ok=0; }
cat "$T/out"; [ "$ok" -eq 1 ] && echo PASS || { echo FAIL; exit 1; }
