#!/bin/sh
# Barra di test-support/isolate-tmp.mjs: un giro di tutti i test non deve lasciare NIENTE in $TMPDIR.
# Esce 1 se resta qualcosa. `--mutation` prova la barra stessa: toglie l'isolamento da un file di
# test in una COPIA in scratch e vuole che la barra diventi rossa (esce 0 solo se morde).
#   DIR=<copia>  esegue contro una copia del repo invece che contro questo.
cd "$(dirname "$0")/.." || exit 2
if [ "$1" = "--mutation" ]; then
    M="$(mktemp -d)" || exit 2
    trap 'rm -rf "$M"' EXIT
    cp -R . "$M/repo" 2>/dev/null
    rm -rf "$M/repo/.git" "$M/repo/.claude"
    sed -i '' "/isolate-tmp.mjs/d" "$M/repo/test/queue.test.mjs"
    if DIR="$M/repo" sh "$M/repo/scripts/tmp-leak-check.sh" >"$M/out" 2>&1; then
        echo "FAIL la barra non morde: tolto l'isolamento da queue.test.mjs e resta verde"; cat "$M/out"; exit 1
    fi
    echo "ok   la barra morde: senza isolamento in queue.test.mjs diventa rossa"; sed 's/^/     /' "$M/out"
    exit 0
fi
cd "${DIR:-.}" || exit 2
R="$(mktemp -d)" || exit 2
trap 'rm -rf "$R"' EXIT
# HOME vuota: i test non devono leggere i log veri del Mac (con quelli, 3 file duravano oltre 90 s l'uno
# invece di 1-2 s) e il giro non dipende da cosa c'è in ~/.claude. Il TMPDIR sta accanto, non dentro.
mkdir "$R/home" "$R/tmp"
HOME="$R/home" TMPDIR="$R/tmp/" node --test test/ modules/vdm/test/ modules/tray/server/test.mjs >"$R/out" 2>&1
rc=$?
left="$(ls -A "$R/tmp" | wc -l | tr -d ' ')"
if [ "$left" != 0 ]; then
    echo "FAIL $left voci lasciate in \$TMPDIR dopo un giro (test exit $rc):"
    ls -A "$R/tmp" | sed -E 's/-?[A-Za-z0-9]{6}$//' | sort | uniq -c | sort -rn | sed 's/^/     /'
    exit 1
fi
echo "ok   0 voci lasciate in \$TMPDIR dopo un giro (test exit $rc)"
