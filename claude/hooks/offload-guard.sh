#!/bin/bash
# PreToolUse(Bash) per Claude Code, Codex e Muse; `pre_tool` per jcode. Stesso protocollo:
# exit 2 + motivo su stderr. jcode lo chiama per ogni strumento e passa l'input nudo
# ({"command": ...}) col nome in JCODE_HOOK_TOOL_NAME e la cartella in JCODE_HOOK_CWD.
# Mac sopra la soglia di offload (carico per core > OFFLOAD_MAX_MAC, 1.5) e comando pesante
# (suite di test, browser headless, build) -> si ferma e dice di rilanciarlo con `offload`.
# Perche' un hook: la riga in TOOLS.md c'era dal 16/10, e il 23/10 alle 02:15 il Mac era a 4
# per core con tre suite Playwright in corsa e il PC acceso all'1%.
# Pesanti sono anche type-check e lint (tsc, tsgo, eslint, knip, run typecheck|lint|check:deadcode, 26/10): stesso
# rifiuto, tranne nei repo di offload-shims/solo-mac.txt (topics-app, .openclaw, jarvis, claude-usage-hub), dove
# passano e il motivo dice di mettere `taskpolicy -b` davanti (bassa priorita', niente PC).
# Il testo guardato e' solo quello che la shell esegue (offload-strip.py): corpi di heredoc, stringhe tra apici e
# commenti non contano, le stringhe di `bash -c` / `eval` si' (falso positivo del 25/10: «pytest» in una regex).
# Guarda anche dentro lo script lanciato (bash x.sh, ./x.sh): le suite pesanti girano quasi
# sempre dentro una barra, e il solo testo del comando non le vede.
# Lascia passare: comandi gia' con `offload`, comandi con `pw-remote` (Playwright: i browser
# sul PC, runner qui), e `OFFLOAD=local` davanti (deve girare qui:
# servizi locali, Xcode, codex o moondream, output di build che serve sul Mac).
# Gabbia (25/10, due incidenti con pkill/killall): per i SOTTOAGENTI di Claude Code (input con
# agent_id) in permission_mode bypassPermissions, l'ultimo passo riscrive il comando perche' giri
# dentro ~/bin/senza-segnali (nessun segnale verso processi fuori dalla gabbia). Solo bypass: in
# auto il classificatore nego' 7 comandi su 36 riscritti (0 su 27 senza hook), nelle altre modalita'
# le regole allow non riconoscono piu' il comando. Non tocca la sessione principale ne'
# Codex/Muse/jcode. Restano fuori: gli agenti in posizione di comando (hanno la loro sandbox) se il
# comando non nomina kill; `SEGNALI=liberi` ad inizio comando; i comandi in cui le parole di una regola
# Bash ask/deny compaiono in sequenza (una regola a piu parole come «open -a OrbStack» vale solo intera,
# e un «*» vale qualunque testo, spazi compresi, come in Claude Code: `pnpm test` e `open -a Safari` restano in gabbia; Claude Code la riconosce in for/do, nice, xargs,
# \cmd, "cmd"..., il comando riscritto no: meglio fuori dalla gabbia che una regola scavalcata); i comandi
# con rm o rmdir come parola (in zsh -c Claude Code non sa controllarli e chiede il permesso anche in bypass);
# ma se lo stesso comando ha anche kill, pkill o killall come parola si rifiuta (exit 2): senza gabbia quei
# segnali arriverebbero fuori (verificatore 25/10, GRAVE: 65 pkill/killall su 715 dei sottoagenti stavano accanto a un rm).
# I comandi che nominano senza-segnali o sandbox-exec si riscrivono (la gabbia annidata funziona).
# Qualunque cosa vada storta: il comando passa com'e'.
# -> tools/gabbia-segnali.md
# stdin letto con un builtin (niente processo); poi il carico: a Mac scarico l'hook costa un
# sysctl e un awk, non jq su ogni comando
[ -n "$JCODE_HOOK_TOOL_NAME" ] && [ "$JCODE_HOOK_TOOL_NAME" != bash ] && exit 0
IFS= read -r -d '' in || true
# pkill/pgrep/killall con opzioni dopo il pattern (25/10: `pkill -f x -P 1` ha ucciso il gateway):
# kill-guard.py, a qualunque carico. Prefiltro con un glob del builtin, nessun processo se il
# comando non li nomina. Stesso input, stesso protocollo (exit 2 + motivo su stderr).
case "$in" in *pkill*|*pgrep*|*killall*)
  printf %s "$in" | python3 "$(dirname "$0")/kill-guard.py"; [ $? = 2 ] && exit 2 ;;
esac
# Attese senza tetto (25/10: una aspettava il PC da 17 h): wait-cap-guard.sh, a qualunque carico.
# Agganciata qui come kill-guard, cosi' vale nei quattro harness da un punto solo (30/10, ok Attilio).
# Prefiltro col glob: nessun processo se il comando non dorme e non segue un file.
case "$in" in *sleep*|*tail*)
  printf %s "$in" | "$(dirname "$0")/wait-cap-guard.sh"; [ $? = 2 ] && exit 2 ;;
esac
# Installer remoti (30/10): curl/wget che alimenta una shell si ferma a qualunque carico, perche' non si annulla
# (lo script gira come Attilio, coi segreti del Keychain a portata) e i sottoagenti in bypass leggono README che
# lo chiedono. Si guarda il testo che la shell esegue (offload-strip.py: niente apici, heredoc, commenti); glob
# prima, nessun processo se curl/wget non sta accanto a una pipe, a $( o a <(. Python escluso apposta: 1.870
# `curl | python3 -c` legittimi. Sui 16.728 comandi storici con curl/wget: 0 bloccati.
case "$in" in *curl*'|'*sh*|*wget*'|'*sh*|*sh*'$('*curl*|*sh*'$('*wget*|*'<('*curl*|*'<('*wget*)
  ic=$(printf %s "$in" | jq -r '.tool_input.command // .command // empty' 2>/dev/null)
  case "$ic" in INSTALLER=ok\ *|cd\ *'&& INSTALLER=ok '*) ;; *)
    ix=$(printf %s "$ic" | python3 -I "$(dirname "$0")/offload-strip.py" 2>/dev/null) || ix=$ic
    if printf %s "$ix" | /usr/bin/grep -qE '(curl|wget)[^|;&]*\|[[:space:]]*(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?([^[:space:]]*/)?(ba|z|da|k)?sh([[:space:]]+(-[abd-zA-Z]*|--?)([[:space:]]|$)|[[:space:]]*($|[;&|)]))|(ba|z|da|k)?sh[[:space:]]+(-[^[:space:]]+[[:space:]]+)*-[a-z]*c[[:space:]]+\$\([[:space:]]*(curl|wget)|(source|\.|(ba|z|da|k)?sh)[[:space:]]+<\([[:space:]]*(curl|wget)'; then
      echo "Installer remoto: questo comando scarica codice da internet e lo esegue senza mostrarlo. Da agente non si lancia: se Attilio te l'ha chiesto in questa conversazione, rilancialo con INSTALLER=ok davanti; altrimenti scrivi nel resoconto cosa, da dove e perche', e lascialo a lui." >&2
      exit 2
    fi ;;
  esac ;;
esac
# Il repo del comando e' in solo-mac.txt (la lista degli shim di OpenClaw, la stessa di offload-shims/_shim)?
# Vale la cartella dopo un `cd X &&` iniziale, altrimenti cwd. Il nome e' quello del repo principale (anche
# da un worktree: git-common-dir) oppure un componente qualunque del percorso.
solo_mac_repo() {
  local list="$HOME/.openclaw/bin/offload-shims/solo-mac.txt" d c p
  [ -f "$list" ] || return 1
  d=$(printf %s "$cmd" | sed -nE 's/^[[:space:]]*cd[[:space:]]+([^;&|[:space:]]+).*/\1/p' | head -1)
  c=$(printf %s "$in" | jq -r '.cwd // empty'); c="${c:-${JCODE_HOOK_CWD:-$PWD}}"
  d="${d/#\~/$HOME}"; d="${d//[\"\']/}"
  case "$d" in "") d=$c ;; /*) ;; *) d="$c/$d" ;; esac
  p=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && {
    p=${p%/.git}; /usr/bin/grep -qxF "${p##*/}" "$list" && return 0; }
  local IFS=/; for p in $d; do [ -n "$p" ] && /usr/bin/grep -qxF "$p" "$list" && return 0; done
  return 1
}
# Blocco delle suite pesanti a Mac carico (invariato): rifiuta con exit 2, altrimenti torna.
offload_check() {
max="${OFFLOAD_MAX_MAC:-1.5}"
load=$(/usr/sbin/sysctl -n vm.loadavg hw.ncpu | awk 'NR==1{l=$2} NR==2{printf "%.2f", l/$1}')
awk -v l="$load" -v m="$max" 'BEGIN{exit !(l > m)}' || return 0

cmd=$(printf %s "$in" | jq -r '.tool_input.command // .command // empty')
[ -n "$cmd" ] || return 0
case "$cmd" in *offload*|*OFFLOAD=local*|*pw-remote*|*PW_TEST_CONNECT_WS_ENDPOINT*) return 0 ;; esac
# Lanciare un agente non e' lavoro pesante: il prompt puo' citare `npm test`, ma i comandi che
# l'agente esegue passano dal suo hook (falso positivo visto il 23/10 su `codex exec "...npm test"`)
first=$(printf %s "$cmd" | sed -E 's/^(cd [^;&|]+(&&|;)[[:space:]]*)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+|timeout[[:space:]]+[0-9]+[[:space:]]+)*//' | awk '{print $1}')
case "${first##*/}" in codex|claude|muse|museagent|codexagent|delegate|jcode|cloud-lancia) return 0 ;; esac

# Suite e build: sempre sul PC a Mac carico. Type-check e lint (tsc, tsgo, eslint, knip, run typecheck|lint|
# check:deadcode) pesano uguale, ma nei repo di solo-mac.txt non possono andare sul PC: restano qui a bassa
# priorita' (taskpolicy -b). `tsgo --lsp` e' un server del linguaggio, non un controllo: non conta.
# fine parola: spazio, ; & | ) o backtick (`echo `npm test``, `(cd a && tsc)`)
# astro/vite/next build chiamati direttamente (npx, npm exec): il 27/10 `npm exec astro build` passava e il Mac era a 4,5 per core.
heavy='playwright[[:space:]]+test|(^|[^[:alnum:]_-])(vitest|jest)([[:space:];&|)`]|$)|cypress[[:space:]]+run|(pnpm|npm|yarn|bun)[[:space:]]+(run[[:space:]]+)?(test|e2e|build)([:[:space:];&|)`]|$)|spec-flow|pytest|cargo[[:space:]]+(test|build)|go[[:space:]]+test|(^|[^[:alnum:]_-])(astro|vite|next|nuxt)[[:space:]]+build([[:space:];&|)`]|$)'
light='(^|[^[:alnum:]_.-])(tsc|tsgo|eslint|knip)([[:space:];&|)`]|$)|(pnpm|npm|yarn|bun)[[:space:]]+(run[[:space:]]+)?(typecheck|type-check|lint|knip|check:deadcode)([:[:space:];&|)`]|$)'
# solo il testo che la shell ESEGUE: niente heredoc, stringhe tra apici, commenti (ma si' le stringhe di
# `bash -c` e `eval`, che girano davvero). Se il filtro non parte, il testo intero (come prima).
strip_exec() { python3 -I "$(dirname "$0")/offload-strip.py" 2>/dev/null || cat; }
scmd=$(printf %s "$cmd" | strip_exec)
find_hit() { # $1 testo -> «core|<hit>» o «light|<hit>» (core vince: una suite accanto a un tsc blocca comunque)
  local t=$1 h
  h=$(printf %s "$t" | sed -E 's/(tsgo|tsc)[[:space:]]+--lsp//g' | grep -oE "$heavy" | head -1)
  h=${h%"${h##*[![:space:]]}"}
  [ -n "$h" ] && { printf 'core|%s' "$h"; return; }
  h=$(printf %s "$t" | sed -E 's/(tsgo|tsc)[[:space:]]+--lsp//g' | grep -oE "$light" | head -1 | sed -E 's/^[^[:alnum:]]//')
  h=${h%"${h##*[![:space:]]}"}
  [ -n "$h" ] && printf 'light|%s' "$h"
}
found=$(find_hit "$scmd")
if [ -z "$found" ]; then
  cwd=$(printf %s "$in" | jq -r '.cwd // empty'); cd "${cwd:-${JCODE_HOOK_CWD:-.}}" 2>/dev/null || true
  for f in $(printf %s "$scmd" | grep -oE '((bash|sh|zsh)[[:space:]]+|^|[;&|][[:space:]]*)\.?\.?/?[[:alnum:]_./~-]+\.(sh|bash)' | grep -oE '[^[:space:];&|]+$'); do
    f="${f/#\~/$HOME}"
    [ -f "$f" ] || continue
    found=$(find_hit "$(head -200 "$f" | strip_exec)")
    [ -n "$found" ] && { found="$found (in $f)"; break; }
  done
fi
[ -n "$found" ] || return 0
kind=${found%%|*}; hit=${found#*|}

# Type-check e lint in un repo di solo-mac.txt: restano qui, a bassa priorita'. Non e' un rifiuto:
# l'hook non sa riscrivere il comando per Codex/Muse/jcode, quindi lo lascia passare e dice di mettere
# `taskpolicy -b` davanti (in Claude Code il testo arriva anche come additionalContext, vedi in fondo).
if [ "$kind" = light ] && solo_mac_repo; then
  case "$scmd" in *taskpolicy*|*"nice "*) return 0 ;; esac
  LOWPRI="Mac a $load per core: $hit e' type-check/lint in un repo solo-Mac (non va sul PC), quindi resta qui ma a bassa priorita': rilancialo con 'taskpolicy -b' davanti (es. taskpolicy -b npx tsc --noEmit)."
  printf '%s\n' "$LOWPRI" >&2
  return 0
fi

# Playwright (test ed e2e): i browser vanno sul PC con pw-remote, non con offload
if printf %s "$hit" | grep -qE 'playwright|e2e'; then
  cat >&2 <<EOF
Mac a $load per core (soglia $max) e questo comando e' Playwright: $hit.
Va con pw-remote: i browser girano sul PC, runner e vite restano qui.
  pw-remote -- <comando>      (es. pw-remote -- npx playwright test)
Cartella dove lanciarlo: quella del progetto. Trappole: ~/.claude/jarvis/memory/tools/pc-offload.md
EOF
  exit 2
fi

cat >&2 <<EOF
Mac a $load per core (soglia $max) e questo comando e' pesante: $hit.
Rilancialo sul PC di casa (20 core, si sveglia da solo): offload -- <comando>
- sul PC gira in cmd.exe: scrivilo per Windows; --mac-cmd "<cmd>" se sul Mac e' diverso
- --get <cartella> per riportare report o risultati sul Mac
- la prima volta nel repo: offload -- "pnpm install --dangerously-allow-all-builds && <comando>"
Se deve girare per forza qui (servizi locali, Xcode, codex/moondream, output di build che serve
sul Mac), metti OFFLOAD=local davanti al comando. Trappole di Windows: ~/.claude/jarvis/memory/tools/pc-offload.md
EOF
exit 2
}
offload_check

# Gabbia: solo input di un sottoagente di Claude Code. Per la sessione principale l'input non ha
# la chiave agent_id (misurato 25/10): il glob lascia passare senza lanciare nessun processo.
cage_command() {
  case "$in" in *'"agent_id"'*) ;; *) return 0 ;; esac
  [ -n "$JCODE_HOOK_TOOL_NAME" ] && return 0
  [ -x "$HOME/bin/senza-segnali" ] && [ -x /usr/bin/sandbox-exec ] && [ -x /bin/zsh ] || return 0
  cwd=$(printf %s "$in" | jq -r '.cwd // empty') || return 0
  # regole Bash di ask/deny: un comando ingabbiato non le riconosce piu' (misurato: una regola ask
  # non ferma il comando riscritto), quindi chi le nomina resta com'e' e passa dal permesso normale.
  # Si tiene il testo della regola senza «Bash(», senza «)» e senza «:*» / « *» finale (una per riga;
  # «*» = tutto: «Bash» nuda o «Bash(*)»)
  files=("/Library/Application Support/ClaudeCode/managed-settings.json" "$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json")
  [ -n "$cwd" ] && files+=("$cwd/.claude/settings.json" "$cwd/.claude/settings.local.json")
  have=(); for f in "${files[@]}"; do [ -f "$f" ] && have+=("$f"); done
  rules=""
  [ ${#have[@]} -gt 0 ] && { rules=$(jq -r '[.permissions.ask[]?, .permissions.deny[]?] | .[] | strings | select(. == "Bash" or startswith("Bash("))
    | if . == "Bash" then "*" else sub("^Bash\\([[:space:]]*";"") | sub("\\)$";"") | sub(":\\*$";"") | sub("[[:space:]]+\\*$";"") | sub("[[:space:]]+$";"") | if . == "" then "*" else . end end' "${have[@]}" 2>/dev/null) || return 0; }
  tmp="${TMPDIR:-/tmp}"; tmp="${tmp%/}"
  # il file della cartella finale non si cancella nel comando riscritto: un rm accanto a uno script
  # `zsh -c` che Claude Code non sa leggere (spazi con \, graffe, heredoc) fa chiedere il permesso
  # ad Attilio anche in bypass (25/10, 12-15 richieste l'ora). Lo pota qui l'hook, fuori dal comando,
  # in una cartella sua: la TMPDIR intera ha decine di migliaia di voci e find costava 43 ms
  tmp="$tmp/segnali-cwd"; [ -d "$tmp" ] || mkdir -p "$tmp" 2>/dev/null || return 0
  find "$tmp" -maxdepth 1 -type f -name 'c.*' -mmin +30 -delete 2>/dev/null
  printf %s "$in" | jq -c --arg rules "$rules" --arg f "$tmp/c.$$.$RANDOM$RANDOM" '
    def sq: "\u0027" + gsub("\u0027"; "\u0027\\\u0027\u0027") + "\u0027";
    # un nome di regola -> regex (i soli caratteri speciali sono gli asterischi della regola)
    def esc: gsub("(?<c>[.^$+?()\\[\\]{}|\\\\])"; "\\" + .c);
    # posizione di comando: inizio, dopo ; & | ( ` { $( o a capo, con assegnazioni e wrapper davanti
    "(^|\n|[;&|(`{]|\\$\\()[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+|timeout[[:space:]]+[0-9a-z.]+[[:space:]]+|nohup[[:space:]]+|env[[:space:]]+|time[[:space:]]+|exec[[:space:]]+)*([^[:space:];&|()]*/)?" as $cp
    | (.tool_input.command // "") as $cmd
    # PAROLE (stesse regole per le regole ask/deny, per rm e per kill): dal testo si tolgono apici, virgolette e
    # backslash, e spazi, a capo e ; & | ( ) { } ` $ < > virgola = diventano spazi; ogni parola sta fra spazi.
    # Cosi do-apici-cker, d-backslash-ocker, "docker" e c=docker (poi $c) danno tutte la parola docker. Con explode e
    # una volta sola: le regex di jq (gsub, splits) su un heredoc da 28 KB costavano secondi
    | def norm: explode | map(if . == 39 or . == 34 or . == 92 then empty
          elif . == 32 or (. >= 9 and . <= 13) or . == 59 or . == 38 or . == 124 or . == 40 or . == 41 or . == 123
            or . == 125 or . == 96 or . == 36 or . == 60 or . == 62 or . == 44 or . == 61 then 32 else . end) | implode;
    select(.hook_event_name == "PreToolUse" and .tool_name == "Bash"
             and (.agent_id | type == "string" and length > 0)
             and .permission_mode == "bypassPermissions"
             and ($cmd | type == "string" and length > 0 and length < 200000)
             # uscita esplicita: SEGNALI=liberi solo all inizio del comando (anche dopo `cd x &&` o altre
             # assegnazioni), non in un punto qualunque: `echo SEGNALI=liberi; pkill x` resta in gabbia
             and ($cmd | test("^[[:space:]]*(cd[[:space:]]+[^;&|]+(&&|;)[[:space:]]*)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*SEGNALI=liberi([[:space:]]|$)") | not)
             # agenti e strumenti con la loro sandbox, in posizione di comando; ma se il comando nomina
             # anche kill/pkill/killall (anche in parole piu lunghe) resta in gabbia: la sandbox annidata
             # funziona (senza-segnali), l eccezione non deve coprire il pkill accanto all agente.
             # senza-segnali e sandbox-exec NON sono eccezioni: si riscrivono, la gabbia annidata parte
             and ((($cmd | test($cp + "(codex|codexagent|museagent|muse|delegate|claude|jcode|opencode|cloud-lancia)([[:space:];&|)]|$)"))
                   and ($cmd | contains("kill") | not)) | not))
    # testo del comando a parole, con uno spazio in testa e in coda
    | (" " + ($cmd | norm) + " ") as $s
    # la parola $n, anche col percorso davanti (/bin/rm, /usr/bin/pkill)
    | def word($n): $s | contains(" " + $n + " ") or contains("/" + $n + " ");
      # regole ask/deny: una regola vale se le sue parole compaiono IN SEQUENZA, consecutive, in un punto qualunque
      # del comando, ognuna anche col percorso davanti (open -a OrbStack, npx supabase start, pnpm db:prepare
      # valgono solo intere: pnpm test resta in gabbia). Un «*» nella regola vale qualunque testo, spazi compresi,
      # come in Claude Code (Bash(git * main) prende git push origin main). Non per posizione: Claude Code riconosce
      # la regola anche dopo for/do, if/then, nice, xargs, command, timeout -k, env -i, la forma backslash-cmd,
      # "cmd"... e il comando riscritto non glielo mostra piu
      def ruled: any(($rules | split("\n") | map(select(length > 0)))[]; . == "*" or
          ((" " + (norm | split(" ") | map(select(length > 0) | split("/") | last
                   | "([^ ]*/)?" + (split("*") | map(esc) | join(".*"))) | join(" +")) + " ") as $re
           | $s | test($re)));
    select(ruled | not)
    # rm / rmdir come parola, anche in heredoc, $( ) o stringhe: chiuso in zsh -c Claude Code non sa controllarlo
    # e chiede il permesso ad Attilio anche in bypass («passes a shell -c script that runs rm»), quindi resta fuori
    # dalla gabbia. Con kill / pkill / killall accanto si rifiuta (la shell fuori da jq stampa il motivo ed esce 2):
    # fuori dalla gabbia quei segnali arriverebbero a tutto il Mac
    | if word("rm") or word("rmdir") then (if word("kill") or word("pkill") or word("killall") then "rm+kill" else empty end) else (
    # la cartella finale torna da un file con nome unico scritto qui, LETTERALE nel comando; nessun rm
    # nel comando (vedi la potatura sopra)
    # il comando originale resta leggibile nel testo (niente eval da variabile): un classificatore che
    # legge il comando riscritto lo vede com e
    # la zsh figlia non ha le funzioni dello snapshot di Claude Code (rg, grep=ugrep, find=bfs): le
    # ricarica dal file dello snapshot, che il guscio esterno trova da functions_source
      ($f | sq) as $q
    | ("[ -r \"$SG_S\" ] && . \"$SG_S\" 2>/dev/null\nsetopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL\ntrap \u0027rc=$?; pwd -P >| \"$SG_F\" 2>/dev/null; exit $rc\u0027 EXIT\n" + $cmd) as $inner
    | ("SG_F=" + $q + " SG_S=\"${functions_source[grep]:-${functions_source[rg]:-${functions_source[find]}}}\" \"$HOME/bin/senza-segnali\" /bin/zsh -c " + ($inner | sq) + "; __sg_rc=$?; __sg_d=; "
       + "[ -r " + $q + " ] && __sg_d=$(<" + $q + "); "
       + "[ -n \"$__sg_d\" ] && cd \"$__sg_d\" 2>/dev/null; (exit $__sg_rc)") as $wrapped
    | {hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: (.tool_input + {command: $wrapped})}}
    ) end
  ' 2>/dev/null
}
out=$(cage_command 2>/dev/null)
# type-check/lint a bassa priorita': in Claude Code (input con hook_event_name) il consiglio arriva anche
# al modello come additionalContext, unito alla eventuale riscrittura della gabbia
if [ -n "$LOWPRI" ] && [ "$out" != '"rm+kill"' ]; then
  case "$in" in *'"hook_event_name"'*)
    if [ -n "$out" ]; then out=$(printf %s "$out" | jq -c --arg n "$LOWPRI" '.hookSpecificOutput.additionalContext = $n' 2>/dev/null) || out=""
    else out=$(jq -nc --arg n "$LOWPRI" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $n}}' 2>/dev/null); fi ;;
  esac
fi
case "$out" in
  '"rm+kill"')
    cat >&2 <<'EOF'
Gabbia dei segnali: questo comando ha insieme rm (o rmdir) e kill, pkill o killall.
Con rm dentro, la gabbia non lo puo' prendere (chiuso in zsh -c, Claude Code chiederebbe il permesso
ad Attilio anche in bypass); fuori dalla gabbia, invece, i segnali arriverebbero a tutto il Mac.
Spezzalo in due chiamate Bash separate: una con le sole rimozioni (rm, rmdir), l'altra con il resto,
dove kill, pkill e killall girano in gabbia. Le parole contano ovunque: anche in stringhe, heredoc e $( ).
-> ~/.claude/jarvis/memory/tools/gabbia-segnali.md
EOF
    exit 2 ;;
  ?*) printf '%s\n' "$out" ;;
esac
exit 0
