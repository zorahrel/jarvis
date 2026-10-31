#!/bin/sh
# Barra dei temporanei dei nostri script: dopo UN giro di ognuno, $TMPDIR deve essere vuoto com'era.
# Ogni giro gira con un TMPDIR suo (la HOME resta la vera: le barre di guardia leggono i loro file);
# esce 1 se un giro lascia qualcosa. Uno script che chiama `mktemp` senza modello non rispetta
# $TMPDIR su macOS e qui sfuggirebbe: i nostri usano sempre `mktemp "${TMPDIR:-/tmp}/nome.XXXXXX"`.
# `--mutation` toglie la pulizia da una COPIA in scratch (mai dal file vero) e vuole ogni giro rosso:
# esce 0 solo se la barra morde su tutti.
# Fuori dalla barra: fatture-ai.sh (parla con Gmail e con il Chrome di Darkroom: la pulizia è un trap
# e sta nel file) e gli script che non toccano mai $TMPDIR.
BIN="${BIN:-$HOME/.claude/setup/bin}"
SHARED="${SHARED:-$HOME/.claude/setup/shared}"

# giro <nome> <comando...>: il comando gira con TMPDIR/HOME propri; stampa quante voci restano.
giro() {
    name="$1"; shift
    R="$(mktemp -d)" || exit 2
    mkdir "$R/t"
    LEAK_STATE="$R/state.json" TMPDIR="$R/t/" "$@" >"$R/out" 2>&1
    rc=$?
    left="$(ls -A "$R/t" | wc -l | tr -d ' ')"
    if [ "$rc" != 0 ]; then
        # un giro che non gira non prova niente: rosso, ma con un'altra parola che «lasciate»
        echo "FAIL $name: il giro non e' andato (exit $rc)"; sed 's/^/       /' "$R/out" | tail -5; res=2
    elif [ "$left" = 0 ]; then
        echo "ok   $name: 0 voci lasciate"; res=0
    else
        echo "FAIL $name: $left voci lasciate in \$TMPDIR ($(ls -A "$R/t" | sed -E 's/[A-Za-z0-9]{6,10}$//' | sort -u | tr '\n' ' '))"; res=1
    fi
    rm -rf "$R"
    return $res
}

# topic-watch --notify con Topics e OpenClaw finti: la sveglia scrive il messaggio in un file e lancia `openclaw`.
topic_watch() {
    python3 - "$1" <<'PY'
import importlib.machinery, importlib.util, os, subprocess, sys, types
loader = importlib.machinery.SourceFileLoader("tw", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("tw", loader))
loader.exec_module(m)
m.STATE = os.environ["LEAK_STATE"]  # fuori da $TMPDIR: non e' un temporaneo
m.resolve = lambda a: {"id": "x", "name": "prova", "sessionKey": "topic:x"}
def status(t):
    t["_mark"] = None
    return "idle", {"id": "m1", "role": "assistant", "content": "risposta di prova"}
m.status = status
subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="", stderr="")
sys.argv = ["topic-watch", "--notify", "x"]
sys.exit(m.main())
PY
}

# agents-build con lo stile che non esiste: set -e lo ferma a metà, dopo aver creato il file generato.
# Deve uscire con errore (è il punto): il giro è buono se l'errore c'è.
agents_build_fail() { ATTENTION_SPAN_STYLE=non-esiste zsh "$1" --check && return 1; return 0; }

cases() { # cases <dir bin> <dir shared> <con quali>: "tutti" o solo i quattro che si mutano
    b="$1"; s="$2"; fail=0
    giro "push-guard-test.sh"          sh "$s/push-guard-test.sh"           || fail=1
    giro "topic-watch --notify"        topic_watch "$b/topic-watch"         || fail=1
    giro "openclaw-heartbeat-watch"    python3 "$b/openclaw-heartbeat-watch" --selftest || fail=1
    giro "agents-build (esce a meta)"  agents_build_fail "$b/agents-build"  || fail=1
    if [ "$3" = tutti ]; then
        giro "branch-guard-test.sh"        sh "$s/branch-guard-test.sh"         || fail=1
        giro "session-neighbours-test.sh"  sh "$s/session-neighbours-test.sh"   || fail=1
    fi
    return $fail
}

if [ "$1" = "--mutation" ]; then
    M="$(mktemp -d)" || exit 2
    trap 'rm -rf "$M"' EXIT
    mkdir "$M/bin" "$M/shared"
    cp "$BIN/topic-watch" "$BIN/openclaw-heartbeat-watch" "$BIN/agents-build" "$M/bin/"
    cp "$SHARED/push-guard-test.sh" "$M/shared/"
    sed -i '' '/^trap .rm -rf "\$T". EXIT$/d' "$M/shared/push-guard-test.sh"
    sed -i '' 's/^        os.unlink(f.name).*$/        pass/' "$M/bin/topic-watch"
    sed -i '' '/atexit.register(shutil.rmtree/d' "$M/bin/openclaw-heartbeat-watch"
    sed -i '' '/^trap .rm -f "\$tmp". EXIT$/d' "$M/bin/agents-build"
    # niente grep -c che confonde: ogni mutazione deve aver davvero cambiato il file
    for f in shared/push-guard-test.sh bin/topic-watch bin/openclaw-heartbeat-watch bin/agents-build; do
        if cmp -s "$M/$f" "$( [ "${f%%/*}" = bin ] && echo "$BIN" || echo "$SHARED" )/${f#*/}"; then
            echo "FAIL la mutazione di $f non ha cambiato niente"; exit 1
        fi
    done
    cases "$M/bin" "$M/shared" mutati > "$M/out"
    red="$(/usr/bin/grep -c '^FAIL .*voci lasciate' "$M/out")"
    sed 's/^/     /' "$M/out"
    if [ "$red" = 4 ]; then echo "ok   la barra morde: 4 mutazioni, 4 giri rossi"; exit 0; fi
    echo "FAIL la barra non morde su tutti: $red giri rossi su 4"; exit 1
fi

cases "$BIN" "$SHARED" tutti
rc=$?
[ "$rc" = 0 ] && echo "BARRA VERDE" || echo "BARRA ROSSA"
exit "$rc"
