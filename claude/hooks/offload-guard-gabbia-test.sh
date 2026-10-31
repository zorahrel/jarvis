#!/bin/bash
# Barra della gabbia in offload-guard.sh (25/10): i comandi Bash dei SOTTOAGENTI di Claude Code
# girano dentro ~/bin/senza-segnali. Esce non zero se:
#  - un sottoagente riesce a mandare un segnale a un processo esterno (kill e pkill su un finto);
#  - la sessione principale (niente agent_id), Codex o jcode vengono ingabbiati;
#  - cd non si conserva, o l'exit code / stdout / stderr cambiano (anche con le funzioni dello
#    snapshot di Claude Code: rg, grep=ugrep);
#  - dentro la gabbia non partono ps/top (setuid) o una sandbox annidata (codex, swift...);
#  - un'eccezione copre troppo: agente + pkill nello stesso comando, `SEGNALI=liberi` citato e non
#    usato, una regola ask presa per sottostringa (orb -> absorb), pnpm/npx/open fuori dalla gabbia per
#    una regola a piu parole delle regole vere di Attilio, un comando con rm che si riscrive;
#  - un «*» in mezzo a una regola ask/deny non vale qualunque testo, spazi compresi (come in Claude Code);
#  - un comando con rm e kill/pkill/killall insieme non si rifiuta (exit 2 con lo schema), o si rifiuta
#    dove la gabbia non scatterebbe;
#  - un input rotto blocca il comando (exit != 0, o stampa qualcosa);
#  - un comando che kill-guard o la soglia di offload rifiutano passa;
#  - uno dei mutanti in fondo (sezione 8) resta verde.
# Gira SEMPRE dentro la gabbia (si rilancia da solo in senza-segnali): i comandi riscritti partono in
# una gabbia nuova (`env -u SENZA_SEGNALI`), che e' un sandbox diverso da quello del test e dal finto
# esterno; funziona anche se il test e' lanciato da un sottoagente gia' ingabbiato.
# Sicurezza: il solo processo che i test cercano di segnalare e' un `perl -e sleep` lanciato da qui,
# con un'etichetta unica nell'argv; pkill usa una regex che non trova se stessa. Niente killall.
# Uso: offload-guard-gabbia-test.sh   (exit 0 = verde)
D="$(cd "$(dirname "$0")" && pwd)"
[ -x "$HOME/bin/senza-segnali" ] && [ -x /usr/bin/sandbox-exec ] || { echo "senza-segnali o sandbox-exec mancano: barra non eseguibile"; exit 1; }
[ -n "$SENZA_SEGNALI" ] || exec "$HOME/bin/senza-segnali" "$0" "$@"
# una gabbia nuova dentro la gabbia deve essere possibile (sandbox-exec parte senza sandbox nel profilo)
env -u SENZA_SEGNALI "$HOME/bin/senza-segnali" /usr/bin/true >/dev/null 2>&1 || {
  echo "barra non eseguibile: la gabbia annidata e' rifiutata (gabbia con il profilo vecchio, o altro sandbox). Rilancia con SEGNALI=liberi davanti: il test si ingabbia da solo."; exit 1; }
T=$(mktemp -d -t gabbia-test) || exit 1
FAKE=""
cleanup() { [ -n "$FAKE" ] && kill "$FAKE" 2>/dev/null; /bin/rm -rf "$T"; }
trap cleanup EXIT

# input di PreToolUse come lo manda Claude Code (chiavi misurate il 25/10)
mk() { # $1 comando, $2 permission_mode (bypassPermissions), $3 con|senza agent_id (con), $4 cwd (/tmp)
  jq -nc --arg c "$1" --arg m "${2:-bypassPermissions}" --arg a "${3:-con}" --arg d "${4:-/tmp}" '
    {session_id:"s", cwd:$d, permission_mode:$m, hook_event_name:"PreToolUse", tool_name:"Bash",
     tool_input:{command:$c, timeout:7000, run_in_background:false, description:"prova"}}
    + (if $a == "con" then {agent_id:"a1b2c3", agent_type:"general-purpose"} else {} end)'
}
# esegue l'hook sull'input e stampa il comando riscritto (vuoto = lasciato com'e')
rewritten() { printf %s "$2" | "$1" 2>/dev/null | jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null; }
bad=0
fail() { echo "SBAGLIATO [$SUITE]: $*"; bad=$((bad+1)); }

# snapshot finto: come quello di Claude Code definisce rg/grep come funzioni (la zsh figlia non le eredita)
SNAP="$T/snap.sh"
cat > "$SNAP" <<'EOF'
function rg { echo "FAKE-RG $*"; }
function grep { echo "FAKE-GREP $*"; }
EOF

# esegue il comando riscritto come lo fa il tool Bash: eval in una zsh con lo snapshot, poi riporta
# exit code e cartella. env -u: ogni comando riscritto apre la SUA gabbia (sandbox diverso dal test).
run_tool() { # $1 comando (originale o riscritto), $2 cartella iniziale -> RC=… PWD=… (trap: un `exit` nel comando non lo salta)
  env -u SENZA_SEGNALI /bin/zsh -c '. "$3"; trap '"'"'rc=$?; printf "\n@@RC=%s PWD=%s\n" "$rc" "$(pwd -P)"'"'"' EXIT; cd "$2" || exit 99; eval "$1"' _ "$1" "${2:-/tmp}" "$SNAP"
}

suite() { # $1 = percorso dell'hook
  local H=$1 W w out ref rc
  SUITE=${H##*/}

  # --- 1. chi NON si ingabbia ---
  for c in 'ls' 'cd /usr && pwd'; do
    [ -z "$(rewritten "$H" "$(mk "$c" bypassPermissions senza)")" ] || fail "sessione principale ingabbiata: $c"
  done
  [ -z "$(printf '%s' '{"command":"ls"}' | JCODE_HOOK_TOOL_NAME=bash "$H" 2>/dev/null)" ] || fail "jcode ingabbiato"
  [ -z "$(rewritten "$H" '{"tool_input":{"command":"ls"},"cwd":"/tmp"}')" ] || fail "input senza agent_id (Codex/Muse) ingabbiato"
  for m in default acceptEdits plan dontAsk auto; do
    [ -z "$(rewritten "$H" "$(mk ls $m)")" ] || fail "riscritto in permission_mode $m (auto: il classificatore lo nega; altre: le regole allow non lo riconoscono)"
  done
  for c in 'codex exec -m x "task"' 'delegate -C . "t"' '~/bin/delegate "t"' 'museagent -C . "t"' 'muse exec --yolo x' \
           'claude -p "x"' 'jcode run x' 'opencode run x' \
           'cd /tmp && codex exec "x"' 'FOO=1 timeout 60 codex exec x' 'ls; /opt/homebrew/bin/codex exec x' 'codexagent "t"' \
           'echo a | delegate "t"' 'SEGNALI=liberi pkill -f nulla_di_vero_xyz' 'cd /tmp && SEGNALI=liberi kill -0 1' \
           'FOO=1 SEGNALI=liberi ls' '  SEGNALI=liberi ls'; do
    [ -z "$(rewritten "$H" "$(mk "$c")")" ] || fail "ingabbiato ma ha la sua sandbox o l'uscita: $c"
  done
  # una regola ask/deny sui comandi Bash non va aggirata dalla riscrittura (docker e' ask in settings.json)
  /usr/bin/grep -q '"Bash(docker:\*)"' "$HOME/.claude/settings.json" 2>/dev/null &&
    { [ -z "$(rewritten "$H" "$(mk 'docker ps')")" ] || fail "docker ingabbiato: la regola ask non lo riconoscerebbe"
      [ -z "$(rewritten "$H" "$(mk 'cd /tmp && FOO=1 docker ps')")" ] || fail "docker dopo cd e assegnazione ingabbiato"; }

  # --- 1b. le eccezioni valgono per il comando intero: non devono coprire un pkill accanto (verificatore 25/10) ---
  for c in 'grep -r codex src; pkill -f nulla_di_vero_xyz' \
           'codex exec "x"; pkill -f nulla_di_vero_xyz' \
           'cd /tmp && delegate "t" && killall nulla_di_vero_xyz' \
           'museagent "t"; kill -9 99999999' \
           'echo SEGNALI=liberi ; pkill -f nulla_di_vero_xyz' \
           'ls && SEGNALI=liberi kill -0 1' \
           'ls | sort; pkill -f absorb' \
           'echo forbidden orbit absorb' 'cat orbit.txt' \
           'caffeinate -i codex exec x' 'timeout -k 5 600 codex exec x' 'bunx @openai/codex exec x' 'swift build' \
           'sandbox-exec -p "(version 1)" ls' 'senza-segnali ls' 'ls; ~/bin/senza-segnali true' \
           'pkill -f nulla_di_vero_xyz; sandbox-exec -p "(version 1)(allow default)" true'; do
    [ -n "$(rewritten "$H" "$(mk "$c")")" ] || fail "resta fuori dalla gabbia ma non doveva: $c"
  done

  # --- 1c. regole ask/deny: Claude Code le riconosce anche in for/do, if/then, while, nice, xargs, command,
  # timeout -k, time -p, env -i, \cmd, "cmd"...; il comando riscritto non le vedrebbe piu'. Se UNA parola
  # qualunque del comando e' il primo nome di una regola, resta com'e' (verificatore 25/10, difetto grave).
  # Le regole stanno in settings di progetto finti (zzask, zzdeny...), indipendenti dal settings.json di Attilio.
  mkdir -p "$T/proj/.claude" "$T/proj2/.claude" "$T/proj3/.claude" "$T/proj4/.claude" "$T/proj5/.claude" "$T/proj6/.claude"
  echo '{"permissions":{"ask":["Bash(zzask:*)","Bash(zzmulti sub start:*)","Bash(zzstar*)","Bash(zzw*x)","Bash(zzorb:*)"],"deny":["Bash(zzdeny:*)","Read(zzread)"]}}' > "$T/proj/.claude/settings.json"
  echo '{"permissions":{"ask":["Bash(zzlocal:*)"]}}' > "$T/proj2/.claude/settings.local.json"
  echo '{"permissions":{"ask":["Bash"]}}' > "$T/proj3/.claude/settings.json"
  # le regole vere di Attilio (settings.json, 25/10): le righe a piu parole non devono tenere fuori dalla gabbia pnpm, npx, open
  echo '{"permissions":{"ask":["Bash(docker:*)","Bash(docker-compose:*)","Bash(orb:*)","Bash(orbctl:*)","Bash(open -a OrbStack:*)","Bash(open -a Docker:*)","Bash(npx supabase start:*)","Bash(supabase start:*)","Bash(pnpm db:prepare:*)"]}}' > "$T/proj4/.claude/settings.json"
  # una regola a piu parole sola
  echo '{"permissions":{"ask":["Bash(zzask sub:*)"]}}' > "$T/proj5/.claude/settings.json"
  # un «*» in mezzo alla regola: in Claude Code vale qualunque testo, spazi compresi (docs: Bash(git * main) prende
  # git push origin main); con un «*» da una parola sola una regola futura cosi verrebbe scavalcata dalla gabbia
  echo '{"permissions":{"deny":["Bash(zzgit * main)"]}}' > "$T/proj6/.claude/settings.json"
  for c in 'zzask x' 'cd /tmp && zzask x' 'for i in 1 2; do zzask $i; done' 'for f in *.txt
do
  zzask "$f"
done' 'if true; then zzask; fi' 'if zzask; then echo ok; fi' 'while false; do zzask; done' 'until true; do zzask; done' \
           'nice zzask x' 'nice -n 5 zzask x' 'echo a | xargs zzask' 'xargs -n1 zzask < /dev/null' 'command zzask x' 'command -p zzask x' \
           'timeout -k 5 600 zzask x' 'time -p zzask' 'env -i zzask' 'env -i FOO=1 zzask' '\zzask x' '"zzask" x' "'zzask' x" \
           'echo $(zzask)' 'echo `zzask`' 'bash -c "zzask x"' "sh -c 'zzask x'" 'eval "zzask x"' 'case x in x) zzask;; esac' \
           '{ zzask; }' 'ls && ! zzask' 'ls || zzask' '/usr/local/bin/zzask x' 'find . -exec zzask {} \;' 'sudo zzask x' 'nohup zzask &' \
           'zzdeny now' 'for f in a; do zzdeny $f; done' 'nice zzdeny x' 'zzmulti sub start' 'nice zzmulti sub start x' 'zzstarx foo' 'zzwabcx foo' \
           'FOO=1 BAR=2 zzask x' 'watch -n1 zzask' 'ls
zzask' \
           "zz''ask x" 'zz"a"sk x' 'z\zask x' 'c=zzask; $c x' 'c=zzask $c x' 'for i in 1; do zz""ask; done'; do
    [ -z "$(rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj")")" ] || fail "regola ask/deny scavalcata dalla riscrittura: ${c:0:50}"
  done
  # parole intere: una parola diversa che contiene il nome (o lo contiene come sottostringa) resta in gabbia
  for c in 'echo zzasks xzzask zzask.txt zzorbit zzabsorb' 'cat zzdeny2.log' 'ls /tmp/zzask-dir' 'echo ciao'; do
    [ -n "$(rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj")")" ] || fail "fuori dalla gabbia senza una regola che lo nomini: ${c:0:50}"
  done
  [ -z "$(rewritten "$H" "$(mk 'for i in 1; do zzlocal; done' bypassPermissions con "$T/proj2")")" ] || fail "regola di settings.local.json del progetto scavalcata"
  [ -n "$(rewritten "$H" "$(mk 'for i in 1; do zzask; done' bypassPermissions con "$T/proj2")")" ] || fail "la regola di un altro progetto toglie la gabbia"
  [ -z "$(rewritten "$H" "$(mk 'ls' bypassPermissions con "$T/proj3")")" ] || fail "regola «Bash» nuda: tutto resta fuori dalla gabbia"
  # regola a PIU PAROLE sola («zzask sub»): vale in sequenza, in un punto qualunque; un'altra parola dopo il nome no
  for c in 'zzask sub' 'zzask sub x' 'for i in 1; do zzask sub; done' 'nice zzask sub' 'nice -n 5 zzask sub x' 'cd /tmp && FOO=1 zzask sub' \
           "zz''ask sub" 'zzask "sub"' 'zzask s\ub' 'echo a | xargs zzask sub' 'if true; then zzask sub; fi'; do
    [ -z "$(rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj5")")" ] || fail "regola a piu parole scavalcata: ${c:0:50}"
  done
  for c in 'zzask other' 'for i in 1; do zzask other; done' 'nice zzask other' 'zzask' 'echo sub zzask' 'zzasksub' 'sub zzask'; do
    [ -n "$(rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj5")")" ] || fail "regola a piu parole: fuori dalla gabbia senza la sequenza: ${c:0:50}"
  done
  for c in 'zzgit push origin main' 'zzgit push --force origin main' 'for x in 1; do zzgit -C /x push origin main; done' \
           'nice zzgit push "origin" main' 'zzgit x main'; do
    [ -z "$(rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj6")")" ] || fail "regola con «*» in mezzo scavalcata: ${c:0:50}"
  done
  for c in 'zzgit push origin dev' 'zzgit status' 'echo main zzgit push' 'zzgitx push main'; do
    [ -n "$(rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj6")")" ] || fail "regola con «*» in mezzo: fuori dalla gabbia senza la regola: ${c:0:50}"
  done
  # le regole vere di Attilio: i comandi normali con la stessa prima parola (pnpm, npx, open) restano in gabbia
  # (6c682d8 li teneva fuori: le suite che la gabbia deve coprire)
  for c in 'pnpm test' 'pnpm run build' 'pnpm install' 'npx vitest run' 'npx playwright test' 'npx supabase status' 'npx tsc --noEmit' \
           'open -a Safari' 'open https://example.com' 'supabase status' 'supabase db reset' 'docker-free build' 'echo docker-free' \
           'cd /tmp && pnpm test && npx vitest run' 'for f in a b; do pnpm test $f; done' 'pnpm db:migrate' 'open -a OrbStacks' 'ls orbit'; do
    # soglia di offload alzata: pnpm test e npx playwright test sono comandi pesanti, qui conta solo la gabbia
    [ -n "$(OFFLOAD_MAX_MAC=99 rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj4")")" ] || fail "comando normale fuori dalla gabbia con le regole vere: ${c:0:50}"
  done
  for c in 'docker ps' 'do'"''"'cker ps' 'd\ocker ps' '"docker" ps' "'docker' ps" 'c=docker; $c ps' 'docker-compose up' 'orb list' 'orbctl start' \
           'open -a OrbStack' 'open -a Docker' 'nice open -a OrbStack' 'npx supabase start' 'supabase start' 'pnpm db:prepare' \
           'nice pnpm db:prepare' 'for x in 1; do npx supabase start; done' 'time -p supabase start' 'cd /tmp && pnpm db:prepare --force' \
           'bash -c "open -a Docker"' 'if true; then open -a OrbStack; fi' 'xargs open -a OrbStack' 'op'"''"'en -a OrbStack' 'open -a "OrbStack"' \
           'open -a O'"''"'rbStack' '/usr/bin/open -a Docker'; do
    [ -z "$(rewritten "$H" "$(mk "$c" bypassPermissions con "$T/proj4")")" ] || fail "regola vera di Attilio scavalcata: ${c:0:50}"
  done
  # rm / rmdir come parola: il comando non si riscrive (chiuso in zsh -c Claude Code non controlla l'rm e chiede il
  # permesso ad Attilio anche in bypass: «passes a shell -c script that runs rm»); farm, firmware, trash si riscrivono
  for c in 'rm -rf $P; mkdir $P' 'rm x' 'cd /tmp && rm -f a b' 'rmdir d' '/bin/rm -rf x' 'ls | xargs rm' 'echo $(rm x)' 'echo `rm x`' 'echo "rm x"' "echo 'rm'" \
           'r'"''"'m x' 'r\m x' '"rm" x' 'c=rm; $c x' 'for f in a; do rm "$f"; done' 'git rm x' 'find . -name x -exec rm {} \;' \
           $'python3 - <<\'EOF\'\nimport os\nos.system("rm -rf /tmp/x")\nEOF' $'cat <<EOF\nrm\nEOF' 'P=/tmp/x; rm -rf $P && mkdir $P'; do
    [ -z "$(rewritten "$H" "$(mk "$c")")" ] || fail "comando con rm riscritto: ${c:0:50}"
  done
  for c in 'echo farm' 'ls firmware' 'cat rm.txt' 'echo rmx xrm' 'trash x' 'echo --rm' 'ls --rm-x' 'ls /tmp/rm-dir' 'echo rmdirs'; do
    [ -n "$(rewritten "$H" "$(mk "$c")")" ] || fail "senza rm come parola: doveva riscriversi: ${c:0:50}"
  done
  # rm + kill/pkill/killall come parole: fuori dalla gabbia il segnale arriverebbe fuori, quindi exit 2 con lo
  # schema da seguire (verificatore 25/10, GRAVE; il primo caso e' un comando vero di un sottoagente)
  for c in $'rm -f /tmp/x/*/FAIL-*.png\npkill -f "au4z2/wr"; pkill -f "sink.mjs"' 'rm -rf /tmp/a && kill 12345' \
           'killall nulla_di_vero_xyz; rmdir d' 'codex exec x; rm y; pkill -f nulla_di_vero_xyz' 'rm x; /bin/kill -0 1' \
           'echo a | xargs kill; r'"''"'m x' $'python3 - <<\'EOF\'\nimport os\nos.system("rm -rf /tmp/x; pkill -f y")\nEOF'; do
    out=$(printf %s "$(mk "$c")" | OFFLOAD_MAX_MAC=99 "$H" 2>"$T/e.rk"); rc=$?
    [ $rc = 2 ] && [ -z "$out" ] && /usr/bin/grep -q 'due chiamate' "$T/e.rk" || fail "rm + kill non rifiutato con lo schema (exit $rc): ${c:0:50}"
  done
  # ...ma solo dove la gabbia sarebbe scattata: sessione principale, auto, SEGNALI=liberi, kill dentro una parola
  for args in 'rm x; pkill -f nulla_di_vero_xyz|bypassPermissions|senza' 'rm x; pkill -f nulla_di_vero_xyz|auto|con' \
              'SEGNALI=liberi rm x; pkill -f nulla_di_vero_xyz|bypassPermissions|con' 'rm x; echo skill killer|bypassPermissions|con'; do
    IFS='|' read -r c m a <<<"$args"
    printf %s "$(mk "$c" "$m" "$a")" | OFFLOAD_MAX_MAC=99 "$H" >/dev/null 2>&1; rc=$?
    [ $rc = 0 ] || fail "rm + kill rifiutato dove la gabbia non scatta (exit $rc): $c [$m $a]"
  done
  # il comando che la regola ferma non deve nemmeno partire: l'hook non scrive nulla (ne' updatedInput ne' errori)
  out=$(printf %s "$(mk 'for i in 1; do zzask; done' bypassPermissions con "$T/proj")" | "$H" 2>/dev/null); rc=$?
  [ $rc = 0 ] && [ -z "$out" ] || fail "comando con regola ask: l'hook doveva tacere (exit $rc, out ${out:0:40})"

  # --- 2. chi si ingabbia, e come ---
  [ -n "$(rewritten "$H" "$(mk 'echo ciao' bypassPermissions)")" ] || fail "sottoagente in bypassPermissions non ingabbiato"
  out=$(printf %s "$(mk 'echo ciao')" | "$H" 2>/dev/null)
  printf %s "$out" | jq -e '.hookSpecificOutput | has("permissionDecision") | not' >/dev/null 2>&1 || fail "la riscrittura porta un permissionDecision (non deve toccare il permesso)"
  # run_in_background, timeout, description invariati
  [ "$(printf %s "$out" | jq -c '.hookSpecificOutput.updatedInput | del(.command)')" = '{"timeout":7000,"run_in_background":false,"description":"prova"}' ] \
    || fail "i campi diversi da command non sono copiati: $(printf %s "$out" | jq -c '.hookSpecificOutput.updatedInput | del(.command)')"

  # --- 3. cartella, exit code, stdout/stderr ---
  mkdir -p "$T/sub dir"
  nfiles0=$(ls "${TMPDIR:-/tmp}" | /usr/bin/grep -c '^segnali-cwd\.')
  local cases=(
    'cd /usr && true'
    "mkdir -p '$T/sub dir/n' && cd '$T/sub dir/n'"
    "cd '$T/sub dir'; exit 5"
    'cd /usr; false'
    'true'
    'false'
    'exit 7'
    '(exit 130)'
    'echo out; echo err >&2; exit 3'
    'echo "doppie" '"'"'singole'"'"' $HOME `echo backtick` $(echo sub) \ fine'
    $'cat <<\'EOF\'\nriga uno con $HOME\nriga due\nEOF\ncd /usr'
    $'echo àèìòù ✓ 日本\nexit 4'
    'printf "senza a capo"'
    'cd /nonexistent_gabbia_test 2>/dev/null; echo dopo'
    # funzioni dello snapshot (rg, grep=ugrep di Claude Code): la zsh figlia le deve ritrovare
    'rg -x a b; echo "rc=$?"'
    'echo a1b22 | grep -oP "\d+"; echo "rc=$?"'
    # binari setuid root (ps, top): dentro un sandbox-exec nudo non partono, e in pipeline falliscono in silenzio
    'ps -p 1 -o comm=; echo "rc=$?"'
    'ps -p 1 -o comm= | /usr/bin/grep -c launchd'
    'top -l 1 -n 0 >/dev/null; echo "rc=$?"'
    # sandbox annidata (codex -s, swift package...): l'altra seatbelt deve poter partire
    'command /usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/true; echo "rc=$?"'
    # comandi che nominano senza-segnali o sandbox-exec: ora si riscrivono, la gabbia annidata parte
    '~/bin/senza-segnali /bin/echo annidata; echo "rc=$?"'
    'ls /usr >/dev/null; ~/bin/senza-segnali /usr/bin/false; echo "rc=$?"'
    'sandbox-exec -p "(version 1)(allow default)" /usr/bin/true; echo "rc=$?"'
  )
  for c in "${cases[@]}"; do
    W=$(rewritten "$H" "$(mk "$c")")
    [ -n "$W" ] || { fail "non riscritto: ${c:0:50}"; continue; }
    ref=$(run_tool "$c" "$T" 2>"$T/e.ref"); rc=$(run_tool "$W" "$T" 2>"$T/e.out")
    [ "$ref" = "$rc" ] || fail "stdout/exit/cartella diversi per «${c:0:50}»: atteso [$ref] ottenuto [$rc]"
    cmp -s "$T/e.ref" "$T/e.out" || fail "stderr diverso per «${c:0:50}»: [$(cat "$T/e.ref")] vs [$(cat "$T/e.out")]"
  done
  # i casi con funzioni dello snapshot devono dare davvero le funzioni (non "command not found" uguale in entrambi)
  W=$(rewritten "$H" "$(mk 'rg x; grep y')")
  case "$(run_tool "$W" "$T" 2>&1)" in *"FAKE-RG x"*"FAKE-GREP y"*) ;; *) fail "la zsh figlia non ritrova le funzioni dello snapshot (rg/grep)" ;; esac
  for c in 'ps -p 1 -o comm=' 'top -l 1 -n 0 >/dev/null; echo ok'; do
    W=$(rewritten "$H" "$(mk "$c")")
    case "$(run_tool "$W" "$T" 2>&1)" in *"not permitted"*) fail "dentro la gabbia non parte: $c" ;; esac
  done

  # la zsh figlia ha le stesse opzioni di glob del tool Bash (NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL) anche se lo
  # snapshot le accende (le setopt dello zshrc di Attilio finiscono nello snapshot)
  printf 'function rg { echo FAKE-RG; }\nsetopt EXTENDED_GLOB BARE_GLOB_QUAL\n' > "$T/snap2.sh"
  W=$(rewritten "$H" "$(mk '[[ -o extendedglob ]] && echo EG; [[ -o bareglobqual ]] && echo BGQ; echo fine')")
  out=$(env -u SENZA_SEGNALI /bin/zsh -c '. "$2"; eval "$1"' _ "$W" "$T/snap2.sh" 2>&1)
  [ "$out" = fine ] || fail "la zsh figlia non applica NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL [$out]"
  # niente rm nel comando riscritto: accanto a uno script `zsh -c` che Claude Code non sa leggere
  # (spazi con \, graffe) fa chiedere il permesso anche in bypass, e nessun allow lo scavalca
  # (misurato 25/10: «passes a shell -c script that runs rm»)
  for c in 'cd /usr' 'ls /Library/Application\ Support' 'cp a{1,2} b'; do
    W=$(rewritten "$H" "$(mk "$c")")
    printf %s "$W" | /usr/bin/grep -qE '(^|[^A-Za-z0-9_.-])(/bin/)?rm([[:space:]]|$)' && fail "il comando riscritto contiene rm: ${c:0:40}"
  done
  # i file della cartella finale li pota l'hook: uno vecchio sparisce alla chiamata dopo, uno nuovo resta
  old="${TMPDIR:-/tmp}"; old="${old%/}/segnali-cwd/c.test-vecchio.$$"; new="${old%vecchio.$$}nuovo.$$"
  mkdir -p "${old%/*}"
  : > "$old"; touch -t 202601010000 "$old"; : > "$new"
  rewritten "$H" "$(mk 'true')" >/dev/null
  [ -e "$old" ] && fail "l'hook non pota i file vecchi di segnali-cwd/"
  [ -e "$new" ] || fail "l'hook pota anche i file di segnali-cwd/ appena scritti"
  /bin/rm -f "$old" "$new"
  # un processo lasciato in background dal comando non deve tenere appeso il guscio esterno
  W=$(rewritten "$H" "$(mk '(sleep 5 >/dev/null 2>&1 &); cd /usr; echo fatto')")
  t0=$SECONDS; out=$(run_tool "$W" "$T" 2>&1); t1=$((SECONDS - t0))
  [ "$t1" -le 3 ] || fail "un processo in background tiene appeso il comando (${t1}s)"
  case "$out" in *"fatto"*"PWD=/usr"*) ;; *) fail "background: cartella o output persi [$out]" ;; esac

  # --- 4. il segnale verso un processo esterno non passa; dentro la gabbia si'. ---
  perl -e 'sleep 60' "SGTEST_EXT_$$" & FAKE=$!
  sleep 0.3
  W=$(rewritten "$H" "$(mk "kill -TERM $FAKE")"); [ -n "$W" ] || fail "kill non ingabbiato"
  out=$(run_tool "$W" "$T" 2>&1)
  kill -0 "$FAKE" 2>/dev/null || fail "kill: il sottoagente ha ucciso un processo esterno"
  case "$out" in *"not permitted"*) ;; *) fail "kill: esito inatteso [$out]" ;; esac
  W=$(rewritten "$H" "$(mk "pkill -f 'SGTEST_EXT_[0-9]+'")"); [ -n "$W" ] || fail "pkill non ingabbiato"
  run_tool "$W" "$T" >/dev/null 2>&1
  kill -0 "$FAKE" 2>/dev/null || fail "pkill: il sottoagente ha ucciso un processo esterno"
  # lo stesso con un agente accanto: la forma dell'incidente («codex exec …; pkill …»)
  W=$(rewritten "$H" "$(mk "codex --version >/dev/null 2>&1; pkill -f 'SGTEST_EXT_[0-9]+'")"); [ -n "$W" ] || fail "agente + pkill non ingabbiato"
  run_tool "$W" "$T" >/dev/null 2>&1
  kill -0 "$FAKE" 2>/dev/null || fail "agente + pkill: il sottoagente ha ucciso un processo esterno"
  # `X; senza-segnali Y`: anche X e' in gabbia (il kill verso il finto esterno non passa)
  W=$(rewritten "$H" "$(mk "kill -TERM $FAKE; ~/bin/senza-segnali /usr/bin/true")"); [ -n "$W" ] || fail "kill + senza-segnali non ingabbiato"
  run_tool "$W" "$T" >/dev/null 2>&1
  kill -0 "$FAKE" 2>/dev/null || fail "kill + senza-segnali: il sottoagente ha ucciso un processo esterno"
  # controllo positivo: un figlio lanciato dentro la stessa gabbia si chiude
  W=$(rewritten "$H" "$(mk 'sleep 30 & kill $!; wait; echo chiuso')")
  [ "$(run_tool "$W" "$T" 2>/dev/null | head -1)" = chiuso ] || fail "dentro la gabbia un figlio non e' chiudibile"
  # ...anche un figlio che si porta la sua seatbelt (sandbox annidata): il padre lo chiude (codex ferma i suoi comandi cosi')
  W=$(rewritten "$H" "$(mk 'command /usr/bin/sandbox-exec -p "(version 1)(allow default)" /bin/sleep 30 & kill $!; wait; echo chiuso2')")
  [ "$(run_tool "$W" "$T" 2>/dev/null | head -1)" = chiuso2 ] || fail "un figlio con la sua seatbelt non e' chiudibile dal padre"
  # SEGNALI=liberi: la via d'uscita lascia passare davvero il comando (qui non lo eseguo: e' il kill vero)
  kill "$FAKE" 2>/dev/null; wait "$FAKE" 2>/dev/null; FAKE=""

  # --- 5. guardia che non rompe mai ---
  for broken in '' 'non json' '{' '{"agent_id":"x"' '{"agent_id":"x","tool_input":{"command":5},"hook_event_name":"PreToolUse","tool_name":"Bash","permission_mode":"bypassPermissions"}' \
                '{"agent_id":"x","tool_input":null}' '{"agent_id":"","tool_input":{"command":"ls"}}' '[1,2]'; do
    out=$(printf %s "$broken" | "$H" 2>/dev/null); rc=$?
    [ $rc = 0 ] || fail "input rotto «${broken:0:30}» blocca (exit $rc)"
    [ -z "$out" ] || fail "input rotto «${broken:0:30}» produce output: ${out:0:60}"
  done
  # senza python/jq/sandbox-exec nel PATH il comando passa com'e' (PATH ridotto ma con i binari di base per bash)
  out=$(printf %s "$(mk ls)" | HOME=/nonesiste "$H" 2>/dev/null); rc=$?
  [ $rc = 0 ] && [ -z "$out" ] || fail "senza ~/bin/senza-segnali il comando non passa com'e' (exit $rc, out ${out:0:40})"

  # --- 6. i rifiuti di prima restano rifiuti (anche da sottoagente) ---
  for m in con senza; do
    printf %s "$(mk 'pkill -f foo -P 1' bypassPermissions $m)" | "$H" >/dev/null 2>&1; [ $? = 2 ] || fail "kill-guard non rifiuta piu' ($m agent_id)"
    printf %s "$(mk 'npm test' bypassPermissions $m)" | OFFLOAD_MAX_MAC=0 "$H" >/dev/null 2>&1; [ $? = 2 ] || fail "la soglia di offload non rifiuta piu' ($m agent_id)"
    printf %s "$(mk 'OFFLOAD=local npm test' bypassPermissions $m)" | OFFLOAD_MAX_MAC=0 "$H" >/dev/null 2>&1; [ $? = 0 ] || fail "OFFLOAD=local non passa piu' ($m agent_id)"
  done
  # --- 6b. type-check e lint pesano come le suite; i falsi positivi di testo no (26/10) ---
  # rc dell'hook con la soglia a 0 (Mac sempre «carico»); stderr in $T/e.o, stdout in $T/o.o
  gate() { # $1 comando, $2 cartella, $3 con|senza agent_id
    printf %s "$(mk "$1" bypassPermissions "${3:-senza}" "${2:-$T}")" | OFFLOAD_MAX_MAC=0 "$H" >"$T/o.o" 2>"$T/e.o"; return $?
  }
  mkdir -p "$T/plain" "$T/topics-app/pkg" "$T/jarvis"
  # bloccati fuori dai repo di solo-mac.txt, da sottoagente e da sessione principale
  for a in con senza; do
    for c in 'npx tsc --noEmit' 'tsc -p tsconfig.json' 'bunx tsc --noEmit' 'cd /tmp && tsc' 'pnpm exec tsc -b' './node_modules/.bin/tsc' 'tsgo --noEmit' \
             'pnpm run typecheck' 'npm run typecheck' 'yarn typecheck' 'bun run typecheck' 'eslint .' 'npx eslint src' 'pnpm run lint' 'npm run lint:fix' \
             'knip' 'npx knip --production' 'pnpm run check:deadcode' 'ls; FOO=1 eslint .' 'true && tsc'; do
      gate "$c" "$T/plain" $a; [ $? = 2 ] || fail "type-check/lint non bloccato fuori da solo-mac ($a agent_id): $c"
    done
    gate 'npx tsc' "$T/plain" $a; /usr/bin/grep -q 'offload --' "$T/e.o" || fail "il rifiuto di tsc non suggerisce offload"
    # dentro un repo di solo-mac.txt restano qui: exit 0 e il motivo dice «taskpolicy -b» (stderr e additionalContext)
    for c in 'npx tsc --noEmit' 'eslint .' 'knip' 'pnpm run typecheck' 'pnpm run lint' 'pnpm run check:deadcode'; do
      for d in "$T/topics-app/pkg" "$T/jarvis"; do
        gate "$c" "$d" $a; rc=$?
        [ $rc = 0 ] || fail "type-check/lint bloccato in un repo di solo-mac ($a agent_id, exit $rc): $c in ${d#$T/}"
        /usr/bin/grep -q 'taskpolicy -b' "$T/e.o" || fail "type-check/lint in solo-mac: il messaggio non dice taskpolicy -b: $c"
        [ "$(jq -r '.hookSpecificOutput.additionalContext // empty' "$T/o.o" 2>/dev/null | /usr/bin/grep -c 'taskpolicy -b')" = 1 ] || fail "type-check/lint in solo-mac: manca additionalContext con taskpolicy -b: $c"
      done
    done
    # con il cd davanti vale la cartella del cd, non la cwd
    gate "cd '$T/topics-app' && tsc -p ." "$T/plain" $a; [ $? = 0 ] || fail "cd in un repo di solo-mac: tsc bloccato ($a agent_id)"
    gate "cd '$T/plain' && tsc -p ." "$T/topics-app" $a; [ $? = 2 ] || fail "cd fuori da solo-mac: tsc passa ($a agent_id)"
    # gia' a bassa priorita': passa muto
    gate 'taskpolicy -b npx tsc --noEmit' "$T/topics-app" $a; [ $? = 0 ] && [ ! -s "$T/e.o" ] || fail "taskpolicy -b gia' davanti: l'hook parla ancora"
    # una suite resta rifiutata anche in solo-mac e anche accanto a un tsc (core vince)
    gate 'npm test' "$T/topics-app" $a; [ $? = 2 ] || fail "npm test in solo-mac non e' piu' rifiutato ($a agent_id)"
    gate 'tsc && npm test' "$T/topics-app" $a; [ $? = 2 ] || fail "tsc && npm test in solo-mac passa ($a agent_id)"
    # uscita OFFLOAD=local, e tsgo come server del linguaggio non e' un controllo
    gate 'OFFLOAD=local eslint .' "$T/plain" $a; [ $? = 0 ] || fail "OFFLOAD=local non passa per eslint ($a agent_id)"
    for c in 'tsgo --lsp' 'tsgo --lsp --stdio' 'echo tsc' 'ls tsconfig.json' 'cat knip.json' 'lint-staged' 'pnpm lint-staged'; do
      case "$c" in "echo tsc") continue ;; esac
      gate "$c" "$T/plain" $a; [ $? = 0 ] || fail "bloccato ma non e' un controllo ($a agent_id): $c"
    done
    # falsi positivi di testo: heredoc, apici, virgolette, commenti
    for c in $'python3 - <<\'EOF\'\nimport re\nre.search(r"(unit|pytest|vitest)\\b", x)\nEOF' \
             $'python3 - <<EOF\npytest tsc eslint\nEOF' $'cat <<-EOF\n\tnpm test\n\tEOF' $'cat <<\'X\' > f.txt\nplaywright test\nX\nls' \
             $'cat > r.md <<\'EOF\'\nrun: pnpm run lint, tsc, knip\nEOF\necho ok' \
             'echo "pytest"' 'echo "run pytest later"' "grep 'tsc' file" "grep -rn 'npm test' docs" 'echo "pnpm run lint" | wc -c' \
             'ls # npm test' 'git commit -m "fix: eslint e tsc nei test"' "printf '%s' 'playwright test'" 'echo "$(date) pytest"' \
             'cd /tmp && echo "a pytest b"'; do
      gate "$c" "$T/plain" $a; rc=$?
      [ $rc = 0 ] || fail "falso positivo di testo ($a agent_id, exit $rc): ${c:0:60}"
    done
    # ...ma chi esegue davvero resta rifiutato: dopo &&, ;, |, env, cd, -c, eval, heredoc dato a una shell, $( ) in virgolette
    for c in 'cd x && npm test' 'ls; pytest -q' 'echo a | vitest run' 'FOO=1 BAR=2 jest' 'bash -lc "npm test"' "sh -c 'pytest -q'" "zsh -c 'cd a && tsc -p .'" \
             'timeout 60 bash -c "eslint ."' 'bash -c "echo \"x\"; npm test"' 'eval "npm test"' "xargs -I{} sh -c 'eslint {}'" \
             $'bash <<EOF\nnpm test\nEOF' $'cat x | sh <<\'EOF\'\nnpx tsc\nEOF' 'echo "$(pytest -q)"' 'echo `npm test`' $'cat <<EOF\n$(vitest run)\nEOF' \
             $'cat <<EOF\ntesto\nEOF\npytest' 'echo "x" && npx playwright test' "echo 'x'; npm run build" 'ls && (cd a && tsc)'; do
      gate "$c" "$T/plain" $a; rc=$?
      [ $rc = 2 ] || fail "comando eseguito non rifiutato ($a agent_id, exit $rc): ${c:0:60}"
    done
  done
  # lo script lanciato: pytest in una riga di codice conta, in un commento o in una stringa no
  printf '#!/bin/bash\n# pytest\necho "npm test"\ntsc -p .\n' > "$T/plain/viva.sh"; printf '#!/bin/bash\n# pytest e tsc\necho "npm test, eslint"\n' > "$T/plain/muta.sh"
  gate "bash $T/plain/viva.sh" "$T/plain" senza; [ $? = 2 ] || fail "script con tsc vivo non rifiutato"
  gate "bash $T/plain/muta.sh" "$T/plain" senza; [ $? = 0 ] || fail "script con le parole solo in commenti e stringhe rifiutato"
}

HK="${HOOK_NAME:-offload-guard.sh}"
suite "$D/$HK"

# --- 7. costo (solo a Mac non carico: sotto carico il numero non misura l'hook) ---
load=$(/usr/sbin/sysctl -n vm.loadavg hw.ncpu | awk 'NR==1{l=$2} NR==2{printf "%.2f", l/$1}')
if awk -v l="$load" 'BEGIN{exit !(l <= 1.0)}'; then
  in=$(mk 'ls -la')
  s=$(perl -MTime::HiRes=time -e 'print time')
  for i in 1 2 3 4 5 6 7 8 9 10; do printf %s "$in" | "$D/$HK" >/dev/null 2>&1; done
  e=$(perl -MTime::HiRes=time -e 'print time')
  ms=$(awk -v s="$s" -v e="$e" 'BEGIN{printf "%.0f", (e-s)*100}')   # 10 chiamate: ms per chiamata = (e-s)*1000/10
  [ "$ms" -lt 50 ] || { SUITE=costo; fail "gabbia sopra 50 ms a chiamata ($ms ms)"; }
else
  echo "costo: saltato (Mac a $load per core, la misura non vale)"
fi

# --- 8. mutanti: ognuno rompe UNA cosa, la barra deve diventare rossa ---
# sed -> hook mutato in $T/mut/<nome>/ ; HOME_MUT per il mutante della gabbia senza eccezioni nel profilo
mutant() { # $1 nome, $2 espressione sed sul hook ("" = nessuna), $3 "gabbia" per il profilo nudo
  local n=$1 dir="$T/mut/$1" before mut
  # MUTF = file da mutare se non e' l'hook (offload-strip.py)
  local tf="${MUTF:-offload-guard.sh}"
  mkdir -p "$dir"; cp "$D/$HK" "$dir/offload-guard.sh"; cp "$D/kill-guard.py" "$D/offload-strip.py" "$dir/"
  if [ -n "$2" ]; then
    if [ "${2:0:1}" = "@" ]; then perl -0pi -e "${2:1}" "$dir/$tf"; else sed -i '' "$2" "$dir/$tf"; fi
    cmp -s "$D/${MUTF:-$HK}" "$dir/$tf" && { echo "mutante $n non applicabile: la riga da cambiare non c'e'"; bad=$((bad+1)); return; }
  fi
  before=$bad; bad=0
  if [ "$3" = gabbia ]; then
    # HOME finto con la gabbia di una volta: solo (deny signal), senza le eccezioni per ps/top/sandbox-exec
    mkdir -p "$dir/home/bin"
    cat > "$dir/home/bin/senza-segnali" <<'EOF'
#!/bin/sh
[ -n "$SENZA_SEGNALI" ] && exec "$@"
SENZA_SEGNALI=1; export SENZA_SEGNALI
exec /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny signal)(allow signal (target same-sandbox))' "$@"
EOF
    chmod +x "$dir/home/bin/senza-segnali"
    HOME="$dir/home" suite "$dir/offload-guard.sh" >/dev/null 2>&1
  else
    suite "$dir/offload-guard.sh" >/dev/null 2>&1
  fi
  mut=$bad; bad=$before
  [ "$mut" -gt 0 ] || { echo "SBAGLIATO: il mutante «$n» resta verde"; bad=$((bad+1)); }
}
if [ -z "$GABBIA_NO_MUTANT" ]; then
  mutant riscrittura-tolta     's/^out=\$(cage_command 2>\/dev\/null)$/out=/'
  mutant snapshot-non-ricaricato 's/\[ -r \\"\$SG_S\\" \] && \. \\"\$SG_S\\" 2>\/dev\/null\\n//'
  mutant agente-copre-pkill    's/contains("kill") | not/contains("")/'
  mutant liberi-ovunque        's/test("^\[\[:space:\]\]\*(cd/test("(cd/'
  # i due mutanti del confronto delle regole sostituiscono la riga `def ruled:` dell'hook (perl: sed non regge il testo jq)
  export MUTDEF_POS='def ruled: any(($rules | split("\n") | map(select(length > 0)))[]; . as $n | $n == "*" or ($cmd | test($cp + ($n | esc) + "([[:space:];&|)]|$)")));'
  export MUTDEF_SUB='def ruled: any(($rules | split("\n") | map(select(length > 0)))[]; . as $n | $n == "*" or ($cmd | contains($n)));'
  mutant regola-per-posizione  '@s/def ruled:.*?(?=\n    select\()/$ENV{MUTDEF_POS}/s'
  mutant regola-per-sottostringa '@s/def ruled:.*?(?=\n    select\()/$ENV{MUTDEF_SUB}/s'
  # i tre mutanti della cura del 25/10 (regole a piu parole, rm come parola, apici e backslash tolti):
  # «prima parola» e' il difetto di 6c682d8 (pnpm, npx, open fuori dalla gabbia)
  export MUTDEF_FIRST='def ruled: any(($rules | split("\n") | map(select(length > 0)))[]; . == "*" or ((norm | split(" ") | map(select(length > 0)))[0] as $f | word($f | split("/") | last)));'
  mutant regola-prima-parola   '@s/def ruled:.*?(?=\n    select\()/$ENV{MUTDEF_FIRST}/s'
  mutant rm-tolto              's/if word("rm") or word("rmdir") then/if false then/'
  # rm + kill: il rifiuto tolto lascia il pkill fuori dalla gabbia (com'era in 5ceec44)
  mutant rm-kill-tolto         's/if word("kill") or word("pkill") or word("killall") then "rm+kill" else empty end/empty/'
  mutant apici-non-tolti       's/if \. == 39 or \. == 34 or \. == 92 then empty/if false then empty/'
  # «*» in mezzo a una regola che vale una parola sola (com'era fino a b4eed77)
  mutant asterisco-una-parola  's/map(esc) | join("\.\*")/map(esc) | join("[^ ]*")/'
  mutant glob-senza-opzioni    's/setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL//'
  mutant gabbia-senza-eccezioni ""  gabbia
  # 26/10: heredoc non tolti (falso positivo di «pytest» in una regex), tsc fuori dai pesanti, stringhe di
  # `bash -c` ignorate (comando eseguito che passa), repo di solo-mac.txt trattati come gli altri
  MUTF=offload-strip.py mutant heredoc-non-tolti   's/elif s.startswith("<<", i) and not/elif False and not/'
  MUTF=offload-strip.py mutant stringhe-c-ignorate 's/    return bool(re.fullmatch/    return False and bool(re.fullmatch/'
  MUTF=offload-strip.py mutant apici-tenuti        '@s/else \x27""\x27\)/else " " + body + " ")/'
  mutant tsc-fuori-dai-pesanti '@s/\(tsc\|tsgo\|eslint\|knip\)/(tsgo|eslint|knip)/'
  mutant solo-mac-ignorato     's/solo_mac_repo; then/false; then/'
  mutant potatura-tolta        's/-mmin +30 -delete/-mmin +30 -print/'
fi

if [ "$bad" = 0 ]; then echo "gabbia: tutto verde"; exit 0; fi
echo "gabbia: $bad controlli sbagliati"; exit 1
