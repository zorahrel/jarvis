#!/usr/bin/env bash
# Mutanti: ognuno rompe UNA regola con un sed su una copia, e la sezione di test che la guarda deve
# diventare rossa. Un mutante che lascia la suite verde vuol dire che quella regola non e' provata.
# Prima gira l'originale (deve essere verde), poi i mutanti in parallelo. Exit 0 = tutti rossi come devono.
#
#   openclaw-safe-update-mutants.sh
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd)
SRC=$D/openclaw-safe-update
HEAP=$D/../oc-heapwatch/oc-heapwatch-cont.sh
HEAP_TEST=$D/../oc-heapwatch/oc-heapwatch-quiet-test.sh
SUITE=$D/openclaw-safe-update-test.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/osu-mut.XXXXXX"); trap 'rm -rf "$T"' EXIT

# run <nome> <file originale> <sed> <comando di prova con $M = la copia mutata>
run() {
  local name=$1 file=$2 expr=$3; shift 3
  [ -f "$file" ] || { echo "applicata=no (manca $file)" > "$T/$name.res"; return; }
  local M="$T/$name"; cp "$file" "$M"; chmod +x "$M"
  sed -i '' -e "$expr" "$M"
  if cmp -s "$file" "$M"; then echo "applicata=no" > "$T/$name.res"; return; fi
  M="$M" "$@" > "$T/$name.out" 2>&1; echo "applicata=si rc=$?" > "$T/$name.res"
}

# originali: devono essere verdi, altrimenti un «rosso» dei mutanti non dice niente
( OSU_ONLY=2b "$SUITE" > "$T/orig-2b.out" 2>&1; echo $? > "$T/orig-2b.rc" ) &
( OSU_ONLY=2c "$SUITE" > "$T/orig-2c.out" 2>&1; echo $? > "$T/orig-2c.rc" ) &
( OSU_ONLY=2d "$SUITE" > "$T/orig-2d.out" 2>&1; echo $? > "$T/orig-2d.rc" ) &
( OSU_ONLY=26b "$SUITE" > "$T/orig-26b.out" 2>&1; echo $? > "$T/orig-26b.rc" ) &
( "$HEAP_TEST" > "$T/orig-heap.out" 2>&1; echo $? > "$T/orig-heap.rc" ) &

s2b() { OSU_ONLY=2b OSU_SCRIPT="$M" "$SUITE"; }
s2c() { OSU_ONLY=2c OSU_SCRIPT="$M" "$SUITE"; }
s2d() { OSU_ONLY=2d OSU_SCRIPT="$M" "$SUITE"; }
s26b() { OSU_ONLY=26b OSU_SCRIPT="$M" "$SUITE"; }
sheap() { HEAP_SCRIPT="$M" "$HEAP_TEST"; }

run provenienza-ignorata "$SRC" \
  's/^    if kind:$/    if False:/' s2b &
run ogni-messaggio-utente-e-una-persona "$SRC" \
  's/^        return kind == "external_user"$/        return True/' s2b &
run persona-compressa-non-riconosciuta "$SRC" \
  's/(nav.get("navigation") or nav.get("model") or {})/{}/' s2b &
run finestra-di-due-minuti-ignorata "$SRC" \
  's/WHERE created_at > ?/WHERE created_at > 0/' s2b &
run database-illeggibile-ignorato "$SRC" \
  's/^        return \[f"database degli agenti non leggibile.*$/        return []/' s2b &
run persona-mai-vista "$SRC" \
  's/^            if is_person_message(msg):$/            if False:/' s2b &
run pausa-heap-parte-alle-cinque "$HEAP" \
  's/now >= 4 \* 3600/now >= 5 * 3600/' sheap &
run rollback-per-l-app-del-mac "$SRC" \
  's/^    new = \[x for x in new if APP_DOCTOR not in x\].*$/    pass/' s2d &
run app-chiusa-a-mac-in-uso "$SRC" \
  's/if run(\[MAC_LIBERO\], 10)\[0\] != 0:/if False:/' s2d &
run app-mai-riallineata "$SRC" \
  's/^            app_note = align_app(target).*$/            app_note = None/' s2d &
# verifica del 25/10: l'app chiusa da Attilio verrebbe riaperta, e nessuno scenario lo vedeva
run apre-l-app-chiusa "$SRC" \
  '/^def align_app/,/^def / s/    if not app_running():/    if False:/' s2d &
run app-mai-riallineata-senza-update "$SRC" \
  's/^    note = ("dry-run: " + app_plan(cur)) if dry else align_app(cur)$/    note = None/' s2d &
run app-chiusa-a-openclaw-al-lavoro "$SRC" \
  's/^    busy = wait_idle(APP_IDLE_MIN)$/    busy = []/' s2d &
run aiutanti-di-sparkle-lasciati "$SRC" \
  's/^        left = sparkle_leftovers()$/        left = {}/' s2d &
run aiutanti-col-binario-vivo-chiusi "$SRC" \
  's/ and not os.path.exists(m.group(1))//' s2d &
run errore-di-osascript-buttato "$SRC" \
  's/^    why = f" (osascript exit.*$/    why = ""/' s2d &
# difetti lievi del 25/10: l'app avanti sulla CLI veniva chiusa e riaperta, e il banco non provava che Sparkle di un'altra app resti in pace
run app-avanti-riavviata-come-indietro "$SRC" \
  's/^    return vtuple(base(app)) < vtuple(base(cli))$/    return base(app) != base(cli)/' s2d &
run versione-confrontata-come-testo "$SRC" \
  's/^    return vtuple(base(app)) < vtuple(base(cli))$/    return base(app) < base(cli)/' s2d &
run autoupdate-di-qualunque-app "$SRC" \
  's#^    installer = re.compile(re.escape(str(APP .*$#    installer = re.compile(r".*/Autoupdate "#; s#^ *+ re.escape(APP_ID).*$#                           + r"")#' s2d &
run updater-di-qualunque-app "$SRC" \
  's#+ re.escape(APP_ID) + r"/org#+ r"[^/]+/org#; s#+ re.escape(str(APP)) + r"(?: .*$#+ r"")#' s2d &
run piano-senza-l-app "$SRC" \
  '/f"dopo il verde, {app_plan(target)}",$/d' s2d &
run copia-dell-ultimo-riuscito-cancellata "$SRC" \
  's/or r\[3\] == max(ok)}/}/; s/r\[1\] == "running" or r\[3\] == max(ok)}/r[1] == "running"}/' s26b &
run copia-senza-riga-cancellata "$SRC" \
  's/ or d.name not in known:/:/' s26b &
run copia-giovane-cancellata "$SRC" \
  's/if time.time() - os.lstat(d).st_mtime < CAPTURE_FRESH_S:/if False:/' s26b &
run copie-cancellate-in-dry-run "$SRC" \
  's/^            if not dry:$/            if True:/' s26b &
run gateway-fermato-con-una-persona-che-scrive "$SRC" \
  's/^    busy = busy_reasons()$/    busy = []/' s26b &
run gateway-fermato-sotto-soglia "$SRC" \
  's/if dry or cand < ORIGINALS_MIN_BYTES:/if dry:/' s26b &
run gateway-lasciato-fermo "$SRC" \
  's/^        run(\["openclaw", "gateway", "start"\], 120)$/        pass/' s26b &
wait

bad=0
for o in orig-2b orig-2c orig-2d orig-26b orig-heap; do
  if [ "$(cat "$T/$o.rc")" = 0 ]; then echo "  ok   originale verde: $o"; else echo "  ERRORE originale rosso: $o"; tail -5 "$T/$o.out"; bad=1; fi
done
for r in "$T"/*.res; do
  n=$(basename "$r" .res); res=$(cat "$r")
  case "$res" in
    applicata=no*) echo "  ERRORE $n: la mutazione non si applica ($res; il codice e' cambiato?)"; bad=1 ;;
    *"rc=0") echo "  ERRORE $n: la prova e' rimasta VERDE, la regola non e' coperta"; bad=1 ;;
    *) echo "  ok   $n: rosso come deve ($(grep -c '^  FAIL' "$T/$n.out") FAIL)" ;;
  esac
done
exit $bad
