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
# Sentinelle nei file «veri» della HOME finta (diario, Ti aspetta, numero WhatsApp): i test non devono né mostrarle
# (demo-isolation le cerca nelle API della demo) né cambiarle (HUB_TEST_SANDBOX=1 fa confrontare i file prima e dopo).
H="$R/home"; mkdir -p "$H/.claude/jarvis/state/diario" "$H/.claude/jarvis/private/automazioni/feedback" "$H/.config/claude-usage-hub"
day="$(TZ=Europe/Rome date +%Y-%m-%d)"; now="$(($(date +%s) * 1000))"  # ora vera: con ts 1 (1970) /api/diario?days=7 la scartava e un diario vero letto non si vedeva
echo '{"ts":'"$now"',"source":"sentinella","text":"SENTINELLA diario vero da non mostrare","outcome":"ok"}' > "$H/.claude/jarvis/state/diario/$day.jsonl"
echo '{"kind":"apri","id":"s1","tipo":"decisione","title":"SENTINELLA attesa vera da non mostrare","why":"SENTINELLA motivo vero","from":"sentinella","at":'"$now"'}' > "$H/.claude/jarvis/private/ti-aspetta.jsonl"
echo '{"whatsapp":"+393330001122"}' > "$H/.config/claude-usage-hub/notify.json"
cp -R "$H" "$R/home-prima"
# quota-guard vero (sta nella HOME vera): il test lo prova su fixture, senza la HOME vera non avrebbe chi provare
QG="$HOME/.openclaw/bin/quota-guard.py"
# il log della CLI di OpenClaw sta in /tmp/openclaw (non segue HOME né TMPDIR): ogni sua riga col percorso della
# HOME finta è un test arrivato all'openclaw vero (13 volte alle 08:22 del 24/10, rifiutato dal gateway ma in ERROR)
OCLOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
# openclaw finto in testa al PATH: risponde coi fixture e annota la chiamata; il gateway punta a una porta chiusa
mkdir -p "$R/bin"
cat > "$R/bin/openclaw" <<'FAKE'
#!/bin/sh
echo "$*" >> "${0%/*}/../openclaw-chiamate"
case "$1 $2" in
  "cron list") echo '{"jobs":[]}' ;;
  "message send") ;;
  *) echo '{}' ;;
esac
FAKE
chmod +x "$R/bin/openclaw"
PATH="$R/bin:$PATH" OPENCLAW_GATEWAY_URL="ws://127.0.0.1:9" HOME="$H" TMPDIR="$R/tmp/" HUB_TEST_SANDBOX=1 QUOTA_GUARD_PY="$QG" node --test test/ modules/vdm/test/ modules/tray/server/test.mjs >"$R/out" 2>&1
rc=$?
grep -E "^✖|^not ok" "$R/out" | sort -u | head -20 | sed "s/^/     /"; tail -n 8 "$R/out" | sed "s/^/     /"
oc_real="$(grep -c "$R/home" "$OCLOG" 2>/dev/null || true)"
[ -f "$R/openclaw-chiamate" ] && echo "ok   openclaw finto chiamato $(wc -l < "$R/openclaw-chiamate" | tr -d ' ') volte: $(cut -d' ' -f1-2 "$R/openclaw-chiamate" | sort -u | tr '\n' ',')"
if [ "${oc_real:-0}" != 0 ]; then echo "FAIL un test ha chiamato l'openclaw vero ($oc_real righe nel suo log con la HOME finta)"; exit 1; fi
# i file veri della HOME finta sono quelli di prima
changed="$(diff -rq "$R/home-prima/.claude/jarvis" "$H/.claude/jarvis" 2>&1; diff -rq "$R/home-prima/.config" "$H/.config" 2>&1)"
if [ -n "$changed" ]; then echo "FAIL i test hanno toccato i file veri (nella HOME finta):"; echo "$changed" | sed 's/^/     /'; exit 1; fi
[ "$rc" = 0 ] || { echo "FAIL i test escono $rc (HOME e TMPDIR finti)"; exit 1; }
left="$(ls -A "$R/tmp" | wc -l | tr -d ' ')"
if [ "$left" != 0 ]; then
    echo "FAIL $left voci lasciate in \$TMPDIR dopo un giro (test exit $rc):"
    ls -A "$R/tmp" | sed -E 's/-?[A-Za-z0-9]{6}$//' | sort | uniq -c | sort -rn | sed 's/^/     /'
    exit 1
fi
echo "ok   0 voci lasciate in \$TMPDIR dopo un giro (test exit $rc)"
