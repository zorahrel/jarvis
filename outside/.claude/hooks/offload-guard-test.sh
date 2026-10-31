#!/bin/bash
# Barra di offload-guard.sh: input JSON finti, chi c'è davanti e il carico finti via env, niente di pesante parte davvero.
#   bash ~/.claude/hooks/offload-guard-test.sh      exit 0 = tutto verde
# GUARD=<copia dell'hook> e HEAVY_ERE=<copia delle regole> per i mutanti (usage-hub test/mutants-brake.sh);
# ONLY=<pezzo di nome o di comando> fa girare solo i casi che lo contengono.
set -u
H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GUARD="${GUARD:-$H/offload-guard.sh}"
export HEAVY_ERE="${HEAVY_ERE:-$H/heavy.ere}"
CASES="$H/offload-guard-cases.tsv"; FX="$H/offload-guard-fixtures"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export OFFLOAD_NOTES_DIR="$T/notes" OFFLOAD_GUARD_LOG="$T/guard.jsonl" OFFLOAD_STATE_FILE="$T/mac-state.json" MAC_ATTENTION_BIN=/nonexistent
unset JCODE_HOOK_TOOL_NAME JCODE_HOOK_CWD OFFLOAD_MAX_MAC
F=0; N=0
ok() { N=$((N + 1)); }
ko() { echo "FAIL $1"; F=1; }
SID=00000000-0000-4000-8000-000000000001
# go <attenzione> <carico per core> <comando> [cwd] → exit in $rc, stderr in $err
go() {
  local inp; inp=$(jq -cn --arg c "$3" --arg cwd "${4:-$T}" --arg s "$SID" '{session_id:$s, cwd:$cwd, tool_input:{command:$c}}')
  err=$(printf %s "$inp" | MAC_ATTENTION="$1" OFFLOAD_GUARD_LOAD="$2" bash "$GUARD" 2>&1 >/dev/null); rc=$?
}
want() { [ -z "${ONLY:-}" ] || [[ "$*" == *"$ONLY"* ]]; }
expect() {  # nome, exit atteso, attenzione, carico, comando [cwd]
  want "$1" "$5" || return 0
  go "$3" "$4" "$5" "${6:-}"; [ "$rc" = "$2" ] && ok || ko "$1 (atteso $2, uscito $rc): $5"
}

# 1. la lista dei casi (comandi del 24/10 e falsi positivi), nei tre regimi
# (le scorciatoie `bypass` nel testo del comando non sono un colpo da sole: contano nel corpo degli script, sezione 3)
while IFS=$'\t' read -r want c; do
  case "$want" in ''|\#*) continue ;; esac
  b=2; { [ "$want" = - ] || [ "$want" = bypass ]; } && b=0
  expect "background: $want" $b background 0.5 "$c"
  h=0; [ "$want" != - ] && [ "$want" != bypass ] && h=2
  case "$c" in *OFFLOAD=local*) h=0 ;; esac
  expect "human a Mac carico: $want" $h human 3 "$c"
  expect "human a Mac scarico: $want" 0 human 0.5 "$c"
done < "$CASES"
expect 'delegated come human a Mac carico' 2 delegated 3 'npm run test:unit'
expect 'delegated: le scorciatoie non contano' 0 delegated 3 'export OFFLOAD=local TOPICS_GATE_SLOTS=0'

# 2. mac-state.json del hub SI AGGIUNGE al carico vivo, non lo sostituisce (la prima versione lasciava passare a 2,7 per core)
now=$(( $(date +%s) * 1000 ))
echo "{\"at\":$now,\"strained\":true}" > "$T/mac-state.json"; expect 'stato fresco sotto sforzo, carico basso: fermo' 2 human 0.5 'npm test'
echo "{\"at\":$now,\"strained\":false}" > "$T/mac-state.json"; expect 'stato fresco tranquillo, carico alto: ferma lo stesso' 2 human 3 'npm test'
expect 'stato fresco tranquillo, carico a 2,7 per core: ferma lo stesso' 2 human 2.7 'npm test'
expect 'stato fresco tranquillo, carico a 1,4 per core: passa' 0 human 1.4 'npm test'
expect 'delegated: stesso cancello a 2,7 per core' 2 delegated 2.7 'npm run build'
echo "{\"at\":$((now - 600000)),\"strained\":true}" > "$T/mac-state.json"; expect 'stato vecchio: decide il carico' 0 human 0.5 'npm test'
rm -f "$T/mac-state.json"

# 3. script lanciati
expect 'background `S=…; zsh $S/r4/bar4.sh` (export OFFLOAD=local TOPICS_GATE_SLOTS=0) is blocked' 2 background 0.5 "S=$FX; zsh \$S/r4/bar4.sh"
expect 'bar4.sh lanciato diretto da background' 2 background 0.5 "zsh $FX/r4/bar4.sh"
if want 'env-prefixed script path: OFFLOAD=local /…/gates.sh is scanned'; then
go background 0.5 "OFFLOAD=local $FX/gates.sh"
[ "$rc" = 2 ] && printf %s "$err" | /usr/bin/grep -q 'in .*gates\.sh' && ok || ko "env-prefixed script path: OFFLOAD=local /…/gates.sh is scanned (exit $rc)"
fi
expect 'script dopo un prefisso qualsiasi (LC_ALL=C /…/gates.sh)' 2 background 0.5 "LC_ALL=C $FX/gates.sh"
if want 'python3 scripts/ui-bar.py (fixture imports playwright) is blocked'; then
go background 0.5 'python3 scripts/ui-bar.py' "$FX"
[ "$rc" = 2 ] && printf %s "$err" | /usr/bin/grep -q 'browser' && ok || ko "python3 scripts/ui-bar.py (fixture imports playwright) is blocked (exit $rc)"
fi
expect 'script python leggero passa' 0 background 0.5 'python3 scripts/report.py x.json' "$FX"
expect 'bypass nel corpo dello script lanciato: fermo' 2 background 0.5 "bash $FX/gates.sh"
expect 'bypass nel corpo dello script, human a Mac scarico: passa' 0 human 0.5 "bash $FX/gates.sh"
expect 'leggere uno script non è lanciarlo' 0 background 0.5 "cat $FX/r4/bar4.sh"
expect 'human a Mac scarico lancia bar4.sh' 0 human 0.5 "zsh $FX/r4/bar4.sh"

# 4. heredoc
expect 'cat > notes.md <<EOF … pytest … EOF passes' 0 background 0.5 $'cat > notes.md <<EOF\nla suite si lancia con pytest -q\nEOF'
expect 'heredoc: righe che cominciano per un comando pesante passano' 0 background 0.5 $'cat > notes.md <<EOF\nnpm test\npnpm build\nEOF'
expect 'git commit con heredoc che cita npm test passa' 0 background 0.5 $'git commit -m "$(cat <<\'EOF\'\nfix: npm test verde\nEOF\n)"'
expect 'heredoc dato a python resta' 2 background 0.5 $'python3 - <<\'EOF\'\nimport subprocess\nsubprocess.run("npm test", shell=True)\nEOF'

# 5. avvolti, agenti, sottostringhe
expect 'offload --local -- npm test passa' 0 background 0.5 'offload --local -- npm test'
expect 'cd x && offload -- npm test passa' 0 background 0.5 'cd ~/Projects/x && offload -- pnpm build'
expect 'codex exec col prompt che cita npm test passa' 0 background 0.5 'codex exec "lancia npm test e poi pnpm build"'
expect '`offload` come parola qualunque non avvolge' 2 background 0.5 'echo offload && npm test'
expect 'OFFLOAD=local in background non vale' 2 background 0.5 'OFFLOAD=local npm test'
expect 'OFFLOAD=local per human resta la via d uscita' 0 human 3 'OFFLOAD=local npm test'

# 6. assegnazioni in testa
expect 'B=bun; $B test' 2 background 0.5 'B=bun; $B test --timeout 30000 ./x.test.ts'
expect 'T="npm test" && $T' 2 background 0.5 'T="npm test" && $T'

# 6b. falsi positivi (verifica del 24/10, carico 2,5-5 per core): parole di uno strumento in mezzo agli argomenti di un
# comando leggero. L'hook vecchio li lasciava passare; contano solo i lavori pesanti IN POSIZIONE DI COMANDO.
LIGHT=(
  'git commit -m "aggiorna la config di vitest"' 'git commit -m "fix jest"' 'which tsc' 'ffprobe -v error clip.mp4'
  'brew info ffmpeg' 'man eslint' 'npm view vitest version' 'find ~/Projects -maxdepth 1' 'echo "poi lancia npm test"'
  'gh pr create --body "npm run build verde"' 'OFFLOAD=local ls' 'export OFFLOAD=local TOPICS_GATE_SLOTS=0'
  'grep -n pytest README.md' 'cat package.json | jq .scripts.test' 'ls node_modules/.bin | grep vitest'
  'echo "fatto; poi npm test dopo"' 'git commit -m "fix: ora passa && pnpm build"' 'python3 -c "print(1)  # OFFLOAD=local"'
)
for c in "${LIGHT[@]}"; do
  expect "leggero, human a 5 per core: $c" 0 human 5 "$c"
  expect "leggero, background: $c" 0 background 0.2 "$c"
done

# 6c. avvolti ovunque stiano nel comando (l'hook vecchio li lasciava passare con «offload» in qualunque punto)
WRAPPED=(
  'cd /x && git pull && offload -- npm test' $'cd /x\noffload -- npm test' 'export A=1; offload -- npm test' 'bash -lc "offload -- npm test"'
  '(offload -- npm test)' 'source .env && offload -- pnpm test' 'offload --get out -- "pnpm install && pnpm test"'
  'pw-remote -- npx playwright test' 'PW_TEST_CONNECT_WS_ENDPOINT=ws://pc:9000 npx playwright test' "offload -- bash $FX/r4/bar4.sh"
  'timeout 900 offload --local -- bun test ./server' "codex exec \"esegui bash $FX/gates.sh e riferisci\""
)
for c in "${WRAPPED[@]}"; do
  expect "avvolto, human a 3 per core: $c" 0 human 3 "$c"
  expect "avvolto, background: $c" 0 background 0.5 "$c"
done
# ... e il lavoro pesante in posizione di comando, comunque scritto, si ferma
POS=(
  'time npm test' 'cd x && FOO=1 npm test' 'if [ -f a ]; then npm run build; fi' 'echo ok | xargs -n1 vitest' 'bash -c "cd x && npm test"'
  'eval "npm test"' 'sudo -u x npm test' 'nice -n 10 vitest run' $'echo inizio\nnpm test' 'echo x; npx tsc --noEmit' 'lockf /tmp/l sh -c "bun test"'
  'python3 -c "import subprocess; subprocess.run(\"npm test\", shell=True)"'
)
for c in "${POS[@]}"; do
  expect "in posizione di comando, human a 3 per core: $c" 2 human 3 "$c"
  expect "in posizione di comando, background: $c" 2 background 0.5 "$c"
done
expect 'OFFLOAD=local npm test in background: pesante, non vale' 2 background 0.5 'OFFLOAD=local npm test'

# 6d. lanciatori (verifica del 25/10: il vecchio hook fermava, il nuovo no). Lo strumento pesante è il comando anche quando
# comincia dopo pnpm/yarn/bun/npm (exec, dlx, run, x, o direttamente), time, watch, nice, env... Anche in catena.
# La barra completa (lanciatori × strumenti, confronto col vecchio) è offload-guard-launchers-test.sh.
LAUNCHED=(
  'pnpm vitest run' 'pnpm playwright test' 'pnpm tsc --noEmit' 'pnpm next build' 'pnpm cypress run' 'yarn jest' 'yarn exec vitest'
  'yarn dlx eslint .' 'bun run vitest' 'bun --bun run eslint .' 'bun x playwright test' 'bunx vite build' 'npm exec -- playwright test'
  'npm x vitest run' 'pnpm dlx astro build' '/usr/bin/time -l npm test' 'watch -n 5 npm test' 'nice -n 10 pnpm exec vitest'
  'env FOO=1 nice -n 10 bun x playwright test' 'caffeinate -i bun --bun run vitest' 'pnpm --filter web exec vitest'
  'npx -p typescript tsc --noEmit' 'corepack pnpm vitest run' 'pnpx vitest run' '/opt/homebrew/bin/pnpm vitest run'
  'cd app && time pnpm vitest run' 'timeout 900 pnpm exec playwright test' 'bash -lc "nice -n 10 pnpm exec vitest"' 'pnpm exec nice -n 10 vitest'
)
for c in "${LAUNCHED[@]}"; do
  expect "lanciatore, human a 3 per core: $c" 2 human 3 "$c"
  expect "lanciatore, background: $c" 2 background 0.2 "$c"
done
# ... e dietro lo stesso lanciatore un comando leggero con la parola di uno strumento negli argomenti resta leggero
LAUNCHED_LIGHT=(
  'pnpm add -D vitest' 'yarn add jest' 'bun add -d playwright' 'pnpm view vitest version' 'pnpm --filter web add vitest' 'pnpm exec which vitest'
  'nice -n 10 git commit -m "fix jest"' 'time git commit -m "aggiorna vitest"' '/usr/bin/time -l man eslint' 'env FOO=1 which tsc'
  'watch -n 5 cat jest.log' 'caffeinate -i echo "poi lancia npm test"' 'npx -y cowsay vitest' 'pnpm exec offload -- npm test'
)
for c in "${LAUNCHED_LIGHT[@]}"; do
  expect "lanciatore su comando leggero, human a 5 per core: $c" 0 human 5 "$c"
  expect "lanciatore su comando leggero, background: $c" 0 background 0.2 "$c"
done
expect 'script con un lanciatore nel corpo (bar-pnpm.sh), background' 2 background 0.5 "bash $FX/bar-pnpm.sh"
expect 'script con un lanciatore nel corpo (bar-pnpm.sh), human a 3 per core' 2 human 3 "bash $FX/bar-pnpm.sh"
expect 'script con un lanciatore nel corpo (bar-pnpm.sh), human a Mac scarico' 0 human 0.5 "bash $FX/bar-pnpm.sh"
expect 'script con un lanciatore nel corpo, avvolto da offload' 0 background 0.5 "offload -- bash $FX/bar-pnpm.sh"
expect 'lanciatore e poi offload: avvolto, lo script dentro non si guarda' 0 background 0.5 "pnpm exec offload -- bash $FX/r4/bar4.sh"

# 7. nota del freno consegnata una volta
if want 'note delivered once'; then
mkdir -p "$T/notes"; echo '[freno] fermato il giro di «x» (bun test ×4): un rosso di tempi di questo giro non vale' > "$T/notes/$SID.txt"
go human 0.5 'ls'; first=$rc; firsterr=$err
go human 0.5 'ls'
if [ "$first" = 2 ] && printf %s "$firsterr" | /usr/bin/grep -q 'non vale' && [ "$rc" = 0 ] && [ ! -e "$T/notes/$SID.txt" ] && ls "$T/notes/delivered/$SID-"*.txt >/dev/null 2>&1; then ok; else ko "note delivered once (prima $first, poi $rc)"; fi

fi

if [ -z "${ONLY:-}" ]; then
# 8. jcode: input nudo, solo bash
err=$(printf '{"command":"npm test"}' | MAC_ATTENTION=background JCODE_HOOK_TOOL_NAME=bash bash "$GUARD" 2>&1 >/dev/null); [ $? = 2 ] && ok || ko 'jcode bash: input nudo'
printf '{"command":"npm test"}' | MAC_ATTENTION=background JCODE_HOOK_TOOL_NAME=read bash "$GUARD" 2>/dev/null; [ $? = 0 ] && ok || ko 'jcode: altri strumenti passano'

# 9. guasti: si passa
out=$(jq -cn '{tool_input:{command:"npm test"}}' | OFFLOAD_GUARD_LOAD=0.5 bash "$GUARD" 2>&1); [ $? = 0 ] && ok || ko "mac-attention assente = human, a Mac scarico passa: $out"
printf 'non json' | MAC_ATTENTION=background bash "$GUARD" 2>/dev/null; [ $? = 0 ] && ok || ko 'input illeggibile passa'
jq -cn '{tool_input:{command:"npm test"}}' | MAC_ATTENTION=background HEAVY_ERE=/nonexistent bash "$GUARD" 2>/dev/null; [ $? = 0 ] && ok || ko 'regole illeggibili: passa'

# 10. registro
: > "$T/guard.jsonl"; go background 0.5 'pnpm build'
l=$(tail -1 "$T/guard.jsonl" | jq -r '"\(.verdict) \(.attention) \(.hits[0].cls)"' 2>/dev/null)
[ "$l" = 'blocked background build' ] && ok || ko "guard.jsonl: $l"

fi
echo "$N ok"
exit $F
