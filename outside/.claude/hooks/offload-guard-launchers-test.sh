#!/bin/bash
# Barra dei lanciatori di offload-guard.sh: l'hook nuovo (heavy-scan.pl, conta solo il lavoro in POSIZIONE DI COMANDO) non deve
# lasciar passare un comando che quello vecchio (ae7f342, grep sul testo intero) ferma, quando lo strumento pesante è davvero il
# comando e sta solo dietro un lanciatore: `pnpm vitest run`, `bun run playwright test`, `/usr/bin/time -l npm test`,
# `nice -n 10 pnpm exec vitest`, `watch -n 5 npm test`. Regressione trovata dai verificatori il 25/10: il vecchio fermava, il nuovo no.
#   bash ~/.claude/hooks/offload-guard-launchers-test.sh      exit 0 = nessuna regressione e i rilassamenti voluti ci sono ancora
# Non parte niente di pesante: l'hook legge solo il testo del comando, attenzione e carico sono finti via env.
# La base è la copia congelata di ae7f342 in offload-guard-fixtures/base-ae7f342/ (offload-guard.sh e heavy.ere, byte per byte
# `git show ae7f342:outside/.claude/hooks/…`): sta nel repo perché la barra giri anche dopo l'installazione, dove quel commit non c'è.
# BASE_DIR=<cartella con offload-guard.sh e heavy.ere di riferimento> per un'altra base; NEW_DIR=<cartella dell'hook nuovo> (default: questa).
set -u
H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NEW="${NEW_DIR:-$H}"
BASE="${BASE_DIR:-$H/offload-guard-fixtures/base-ae7f342}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
[ -r "$BASE/offload-guard.sh" ] && [ -r "$BASE/heavy.ere" ] && [ -r "$NEW/offload-guard.sh" ] && [ -r "$NEW/heavy-scan.pl" ] || { echo "file dell'hook illeggibili" >&2; exit 2; }

export OFFLOAD_NOTES_DIR="$T/notes" OFFLOAD_GUARD_LOG="$T/guard.jsonl" OFFLOAD_STATE_FILE="$T/nessuno.json" MAC_ATTENTION_BIN=/nonexistent
unset JCODE_HOOK_TOOL_NAME JCODE_HOOK_CWD OFFLOAD_MAX_MAC HEAVY_SCAN HEAVY_ERE MAC_ATTENTION_WHY
SID=00000000-0000-4000-8000-000000000001

# quattro esiti per comando: umano a 3 per core, sessione laterale a 0,2 per core, vecchio e nuovo
code() {  # guard ere attenzione carico input
  printf %s "$5" | HEAVY_ERE="$2" MAC_ATTENTION="$3" OFFLOAD_GUARD_LOAD="$4" bash "$1" >/dev/null 2>&1; echo $?
}
REGIMES=("human 3" "background 0.2")

# 1. il corpo di uno script lanciato: lo scrive la barra in una cartella sua, nessuno lo esegue
mkdir -p "$T/scripts"
BODIES=(
  'pnpm playwright test' 'bun run vitest' 'nice -n 10 pnpm exec vitest' '/usr/bin/time -l npm test' 'watch -n 5 npm test'
  'yarn jest' 'bun x playwright test' 'npm exec -- tsc --noEmit' 'env FOO=1 pnpm eslint .'
)
SCRIPTS=(); i=0
for b in "${BODIES[@]}"; do
  i=$((i + 1)); printf '#!/bin/bash\nset -e\ncd "$(dirname "$0")"\n%s\n' "$b" > "$T/scripts/bar-$i.sh"
  SCRIPTS+=("bash $T/scripts/bar-$i.sh")
done
SCRIPTS+=("zsh $T/scripts/bar-1.sh" "sh $T/scripts/bar-2.sh" "$T/scripts/bar-3.sh")

# 2. il corpus: lanciatori × strumenti, le forme viste in verifica, le catene
TOOLS=("vitest run" "jest" "playwright test" "cypress run" "tsc --noEmit" "eslint ." "astro build" "vite build" "next build")
LAUNCH=(
  "" "pnpm " "pnpm exec " "pnpm dlx " "yarn " "yarn exec " "yarn dlx " "npx " "npx -y " "bunx " "bun x " "bun run " "bun --bun run "
  "bun --bun x " "npm exec " "npm exec -- " "npm x " "/usr/bin/time " "/usr/bin/time -l " "time " "watch -n 5 " "nice -n 10 " "env FOO=1 "
  "caffeinate -i "
)
PKG=("pnpm " "pnpm exec " "pnpm dlx " "yarn " "yarn exec " "yarn dlx " "npx " "npx -y " "bunx " "bun x " "bun run " "bun --bun run " "bun --bun x " "npm exec " "npm exec -- " "npm x ")
WRAP=("/usr/bin/time -l " "watch -n 5 " "nice -n 10 " "env FOO=1 " "caffeinate -i ")
CORPUS=()
for l in "${LAUNCH[@]}"; do for t in "${TOOLS[@]}"; do CORPUS+=("$l$t"); done; done
CORPUS+=(
  # le forme riprodotte dai verificatori
  'bun run vitest' 'bun run playwright test' 'bun x playwright test' 'bun --bun run vitest' 'bun run jest' 'bun run tsc --noEmit'
  'bun run eslint .' 'bun run astro build' 'bun run vite build' 'bun run next build' 'pnpm playwright test' 'pnpm vitest run' 'pnpm jest'
  'pnpm tsc --noEmit' 'pnpm eslint .' 'pnpm astro build' 'pnpm next build' 'pnpm vite build' 'pnpm cypress run' 'yarn playwright test'
  'yarn vitest' 'yarn jest' 'npm exec vitest' 'npm exec -- playwright test' 'bun x vitest run' '/usr/bin/time -l npm test' 'watch -n 5 npm test'
  # lanciatori di scorciatoia davanti a un lavoro che non è un eseguibile da pacchetto
  'time npm test' 'nice -n 10 npm run build' 'env FOO=1 bun test' 'caffeinate -i pnpm build' 'watch -n 5 pytest -q' '/usr/bin/time -l cargo build'
  # catene e forme vicine
  'nice -n 10 pnpm exec vitest' 'env FOO=1 nice -n 10 bun x playwright test' 'time pnpm vitest run' '/usr/bin/time -l nice -n 10 yarn jest'
  'caffeinate -i bun --bun run vitest' 'watch -n 5 pnpm exec playwright test' 'FOO=1 /usr/bin/time -l pnpm vitest' 'cd x && nice -n 10 pnpm exec vitest'
  'pnpm --filter web exec vitest' 'pnpm -C app exec playwright test' 'pnpm -r exec tsc --noEmit' 'npm exec --yes -- eslint .' 'npx -p typescript tsc --noEmit'
  'corepack pnpm vitest run' 'pnpx vitest run' '/opt/homebrew/bin/pnpm vitest run' '~/.bun/bin/bun run vitest' 'timeout 900 pnpm vitest run'
  'bash -lc "pnpm vitest run"' 'bash -c "nice -n 10 pnpm exec vitest"' 'echo ok | xargs -n1 pnpm vitest' 'sudo -u x bun run playwright test'
  'FOO=1 BAR=2 pnpm exec vitest' 'if true; then yarn jest; fi' $'echo inizio\npnpm playwright test' 'pnpm exec nice -n 10 vitest'
  'caffeinate -t 3600 pnpm vitest run' 'nice -n -5 bun run vitest' 'time -p pnpm vitest run'
)
for p in "${PKG[@]}"; do for w in "${WRAP[@]}"; do CORPUS+=("$w${p}vitest run"); done; done
for w in "${WRAP[@]}" "time "; do for t in "npm test" "pnpm build" "pytest -q"; do CORPUS+=("$w$t"); done; done
CORPUS+=("${SCRIPTS[@]}")

# 3. i rilassamenti voluti: parole di uno strumento negli argomenti di un comando leggero, anche dietro un lanciatore.
# Il vecchio li fermava (grep sul testo intero), il nuovo no: nuovo = 0 sempre; la barra li conta ma non li confronta col vecchio.
RELAX=(
  'git commit -m "fix jest"' 'nice -n 10 git commit -m "aggiorna la config di vitest"' 'time git commit -m "fix: ora passa && pnpm build"'
  '/usr/bin/time -l man eslint' 'env FOO=1 which tsc' 'caffeinate -i echo "poi lancia npm test"' 'watch -n 5 cat jest.log'
  'pnpm add -D vitest' 'yarn add jest' 'bun add -d playwright' 'npm install --save-dev vitest' 'pnpm view vitest version' 'pnpm why jest'
  'pnpm --filter web add vitest' 'npx -y cowsay vitest' 'pnpm exec which vitest' 'bun run echo jest' 'nice -n 10 grep -n pytest README.md'
  'brew info ffmpeg' 'npm view vitest version' 'echo "poi lancia npm test"' 'gh pr create --body "npm run build verde"'
  'ls node_modules/.bin | grep vitest' 'cat package.json | jq .scripts.test'
)

bad=0; compared=0; kept=0; dropped=0; n=0
for c in "${CORPUS[@]}"; do
  inp=$(jq -cn --arg c "$c" --arg cwd "$T" --arg s "$SID" '{session_id:$s, cwd:$cwd, tool_input:{command:$c}}')
  b1=$(code "$BASE/offload-guard.sh" "$BASE/heavy.ere" human 3 "$inp"); b2=$(code "$BASE/offload-guard.sh" "$BASE/heavy.ere" background 0.2 "$inp")
  # solo ciò che la base ferma: gli altri non hanno niente da perdere
  if [ "$b1" != 2 ] && [ "$b2" != 2 ]; then dropped=$((dropped + 1)); continue; fi
  n=$((n + 1))
  for r in "${REGIMES[@]}"; do
    set -- $r; b=$b1; [ "$1" = background ] && b=$b2
    [ "$b" = 2 ] || continue
    nw=$(code "$NEW/offload-guard.sh" "$NEW/heavy.ere" "$1" "$2" "$inp"); compared=$((compared + 1))
    if [ "$nw" -lt "$b" ] 2>/dev/null; then bad=$((bad + 1)); printf 'REGRESSIONE %-10s per core %-4s nuovo=%s base=%s: %s\n' "$1" "$2" "$nw" "$b" "$c"; fi
  done
done

lost=0
for c in "${RELAX[@]}"; do
  inp=$(jq -cn --arg c "$c" --arg cwd "$T" --arg s "$SID" '{session_id:$s, cwd:$cwd, tool_input:{command:$c}}')
  for r in "${REGIMES[@]}"; do
    set -- $r
    nw=$(code "$NEW/offload-guard.sh" "$NEW/heavy.ere" "$1" "$2" "$inp")
    if [ "$nw" != 0 ]; then lost=$((lost + 1)); printf 'RILASSAMENTO PERSO %-10s per core %-4s nuovo=%s: %s\n' "$1" "$2" "$nw" "$c"; fi
  done
  kept=$((kept + 1))
done

echo "corpus $n comandi che la base ferma ($dropped scartati: la base li lascia passare), $compared confronti (umano a 3 per core, laterale a 0,2), $bad regressioni; rilassamenti voluti: $kept comandi, $lost persi"
[ "$bad" = 0 ] && [ "$lost" = 0 ]
