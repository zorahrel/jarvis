#!/bin/sh
# Banco della patch openclaw-cron-history-names, su una copia del pacchetto installato (clone APFS, il vivo
# resta intatto). Exit 0 = tutti i casi come attesi:
#   1. dist originale: test-history.mjs esce 1 («Cron job names must be prepared»: il difetto c'e')
#   2. apply, poi test-history.mjs esce 0, check esce 0, un secondo apply non cambia niente
#   3. mutante (risolutore assente invece che vuoto): esce 1, quindi il test discrimina
#   4. revert riporta il file byte per byte all'originale, check esce 1
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PATCH="$HERE/openclaw-cron-history-names.py"
PKG=$(dirname "$(dirname "$(realpath "$(command -v openclaw)")")")
[ -f "$PKG/package.json" ] || PKG=$(dirname "$(realpath "$(command -v openclaw)")")
T=$(mktemp -d /tmp/cron-history-names.XXXXXX)
trap 'rm -rf "$T"' EXIT
cp -cR "$PKG" "$T/pkg" 2>/dev/null || cp -R "$PKG" "$T/pkg"
D="$T/pkg/dist"
fail=0
storia() {  # $1 = atteso
  OC_DIST="$D/" node "$HERE/test-history.mjs" >"$T/out" 2>&1
  rc=$?
  if [ "$rc" = "$1" ]; then echo "ok   $2 (exit $rc)"; else echo "FAIL $2: exit $rc, atteso $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}
F=$(OPENCLAW_DIST="$D" python3 -c "import importlib.util as u,sys;s=u.spec_from_file_location('p',sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);print(m.target())" "$PATCH")
# Il pacchetto installato puo' essere gia' patchato (la patch vive sul disco): la copia torna all'originale,
# altrimenti i casi 1 e 4 cadono senza che la patch c'entri.
OPENCLAW_DIST="$D" python3 "$PATCH" revert >/dev/null 2>&1 || true
cp "$F" "$T/orig"

storia 1 "1. originale: il difetto si riproduce"
OPENCLAW_DIST="$D" python3 "$PATCH" apply >/dev/null || { echo "FAIL apply"; fail=1; }
storia 0 "2. patchato: chat.history legge la sessione col messaggio del cron"
OPENCLAW_DIST="$D" python3 "$PATCH" check >/dev/null && echo "ok   2b. check dopo apply" || { echo "FAIL check dopo apply"; fail=1; }
cp "$F" "$T/once"; OPENCLAW_DIST="$D" python3 "$PATCH" apply >/dev/null
cmp -s "$F" "$T/once" && echo "ok   2c. apply idempotente" || { echo "FAIL secondo apply ha cambiato il file"; fail=1; }

sed -i '' 's/resolveCronJobName: () => void 0 \/\/ jarvis-patch/resolveCronJobName: void 0 \/\/ jarvis-patch/' "$F"
storia 1 "3. mutante (risolutore assente): il test lo prende"
cp "$T/once" "$F"

OPENCLAW_DIST="$D" python3 "$PATCH" revert >/dev/null
cmp -s "$F" "$T/orig" && echo "ok   4. revert byte per byte" || { echo "FAIL revert diverso dall'originale"; fail=1; }
OPENCLAW_DIST="$D" python3 "$PATCH" check >/dev/null; [ $? = 1 ] && echo "ok   4b. check dopo revert = 1" || { echo "FAIL check dopo revert"; fail=1; }
exit $fail
