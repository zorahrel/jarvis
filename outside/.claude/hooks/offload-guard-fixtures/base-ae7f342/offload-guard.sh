#!/bin/bash
# PreToolUse(Bash) per Claude Code, Codex e Muse; `pre_tool` per jcode. Stesso protocollo:
# exit 2 + motivo su stderr. jcode lo chiama per ogni strumento e passa l'input nudo
# ({"command": ...}) col nome in JCODE_HOOK_TOOL_NAME e la cartella in JCODE_HOOK_CWD.
#
# Cosa ferma (24/10, il freno del Mac):
# - sessioni che nessuno guarda (bin/mac-attention.mjs dice background): ogni lavoro pesante e ogni scorciatoia
#   (OFFLOAD=local, TOPICS_GATE_SLOTS=0), a qualunque carico. Passano da `offload --local --` (la coda comune coi gate
#   di Topics) o da `offload --` (PC). Il 24/10 due agenti in background si erano scritti un'attesa in casa a carico
#   35 e avevano esportato tutte e due le scorciatoie: il testo del comando non le vedeva (`$B test`, `bun run $g`).
# - sessioni con qualcuno davanti e alberi di Topics (human, delegated): come prima, solo a Mac sotto sforzo
#   (mac-state.json del hub, o carico per core > OFFLOAD_MAX_MAC); OFFLOAD=local davanti resta la via d'uscita.
# La lista dei lavori pesanti è heavy.ere, la stessa che usa il freno del hub mentre girano.
# Guarda dentro gli script lanciati (sh, py, mjs, ts...), anche dopo assegnazioni (`OFFLOAD=local /x/gates.sh`) e
# dopo `S=…; zsh $S/bar4.sh`. Consegna una volta, alla prossima chiamata, la nota che il freno ha lasciato alla sessione.
# Un guasto di questo controllo non ferma niente: si esce 0.
[ -n "${JCODE_HOOK_TOOL_NAME:-}" ] && [ "$JCODE_HOOK_TOOL_NAME" != bash ] && exit 0
IFS= read -r -d '' in || true
G=/usr/bin/grep   # mai ugrep: salta i file "ignorati" e cambia le regex
case "${BASH_SOURCE[0]}" in */*) HERE="${BASH_SOURCE[0]%/*}" ;; *) HERE=. ;; esac
RULES="${HEAVY_ERE:-$HERE/heavy.ere}"
HUBC="$HOME/.cache/claude-usage-hub"
NOTES="${OFFLOAD_NOTES_DIR:-$HUBC/notes}"
STATE="${OFFLOAD_STATE_FILE:-$HUBC/mac-state.json}"
LOG="${OFFLOAD_GUARD_LOG:-$HOME/.cache/offload/guard.jsonl}"
max="${OFFLOAD_MAX_MAC:-1.5}"

# (f) la nota del freno: stampata, spostata in delivered/, exit 2 una volta sola
sid=""; re_sid='"session_id"[[:space:]]*:[[:space:]]*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"'
[[ $in =~ $re_sid ]] && sid=${BASH_REMATCH[1]}
if [ -n "$sid" ] && [ -s "$NOTES/$sid.txt" ]; then
  dst="$NOTES/delivered/$sid-$(date +%s).txt"
  if mkdir -p "$NOTES/delivered" 2>/dev/null && mv "$NOTES/$sid.txt" "$dst" 2>/dev/null; then
    { echo "Nota del freno del Mac su un tuo lavoro (te la dico una volta; poi rilancia il comando se serve):"; cat "$dst"; } >&2
    exit 2
  fi
fi

cmd=$(printf %s "$in" | jq -r '.tool_input.command // .command // empty' 2>/dev/null)
[ -n "$cmd" ] && [ -r "$RULES" ] || exit 0
cwd=$(printf %s "$in" | jq -r '.cwd // empty' 2>/dev/null); cwd="${cwd:-${JCODE_HOOK_CWD:-$PWD}}"

# (b) i corpi dei heredoc che scrivono un file (cat > x <<EOF) non si eseguono: via. Restano quelli dati a un interprete.
text=$(printf '%s\n' "$cmd" | awk '
  tag != "" { l = $0; sub(/^\t+/, "", l); if (l == tag) tag = ""; next }
  { print
    if (match($0, /<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*["\047]?/)) {
      pre = substr($0, 1, RSTART - 1); t = substr($0, RSTART, RLENGTH)
      if (pre ~ /<$/) next
      gsub(/^<<-?[ \t]*["\047]?|["\047]$/, "", t)
      if (pre !~ /(^|[;&|( \t])(bash|sh|zsh|python3?|node|bun|deno|ruby|perl|osascript)[ \t]+(-[^ \t]*[ \t]*)*$/) tag = t
    } }')

# (c) avvolto: il primo vero comando (dopo cd …&&, assegnazioni, timeout N) è offload, o il lancio di un agente
# (il prompt può citare `npm test`, ma i comandi dell'agente passano dal suo hook)
first=$(printf '%s\n' "$text" | head -1 | sed -E 's/^[[:space:]]*(cd [^;&|]+(&&|;)[[:space:]]*)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+|timeout[[:space:]]+[0-9]+[[:space:]]+|nice[[:space:]]+(-n[[:space:]]*[0-9]+[[:space:]]+)?)*//' | awk '{print $1}')
case "${first##*/}" in offload|codex|claude|muse|museagent|codexagent|delegate|jcode|cloud-lancia) exit 0 ;; esac

# (d) assegnazioni in testa (`S=/x; zsh $S/bar4.sh`, `B=bun && $B test`): si sostituiscono prima di cercare
exp="$text"
lead='^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*='
if [[ $text =~ $lead ]]; then
  exp=$(printf '%s' "$text" | perl -0777 -ne '
    my $c = $_; my %v;
    while ($c =~ s/^\s*(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|\x27[^\x27]*\x27|[^\s;&|]*)\s*(?:;|&&|\n)\s*//) {
      my ($n, $x) = ($1, $2); $x =~ s/^(["\x27])(.*)\1$/$2/s;
      $x =~ s/\$(?:\{(\w+)\}|(\w+))/my $k = defined $1 ? $1 : $2; exists $v{$k} ? $v{$k} : $&/ge;
      $v{$n} = $x;
    }
    for my $n (keys %v) { $c =~ s/\$(?:\{$n\}|$n(?!\w))/$v{$n}/g }
    print $c;' 2>/dev/null) || exp="$text"
fi
exp="${exp//\~\//$HOME/}"

# regole: classe<TAB>dove<TAB>ERE, alla partenza contano start, both e bypass
pats=$(awk -F'\t' '!/^#/ && NF >= 3 && $2 != "run" && $3 != "" { print $3 }' "$RULES")
classify() {  # $1 testo, $2 origine → righe "classe<TAB>testo<TAB>origine", in ordine di file
  local t="$1" o="$2" c w e h
  printf '%s\n' "$t" | $G -qE -e "$pats" 2>/dev/null || return 0
  while IFS=$'\t' read -r c w e; do
    case "$c" in ''|\#*) continue ;; esac
    [ "$w" = run ] && continue
    h=$(printf '%s\n' "$t" | $G -oE -m1 -e "$e" 2>/dev/null | head -1)
    [ -n "$h" ] && printf '%s\t%s\t%s\n' "$c" "$h" "$o"
  done < "$RULES"
}
hits=$(classify "$text
$exp" "")

# script lanciati: in testa a un comando (anche dopo assegnazioni) o dopo un interprete; prime 300 righe
scripts=$(printf '%s\n' "$exp" | $G -oE '(^|[;&|(][[:space:]]*|(bash|sh|zsh|python3?|node|bun|tsx|deno)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(run[[:space:]]+)?)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*[^[:space:];&|()<>"'"'"'=$]+\.(sh|bash|zsh|py|mjs|js|cjs|ts)([[:space:];&|)]|$)' \
  | sed -E 's/[[:space:];&|)]+$//; s/.*[[:space:];&|(=]//' | head -5)
for f in $scripts; do
  case "$f" in /*) p="$f" ;; *) p="$cwd/$f" ;; esac
  [ -f "$p" ] || continue
  case "$p" in
    *.sh|*.bash|*.zsh) body=$(head -300 "$p" 2>/dev/null | $G -vE '^[[:space:]]*#') ;;
    # negli altri linguaggi contano solo le righe che importano o lanciano qualcosa, non le stringhe di un sorgente
    *) body=$(head -300 "$p" 2>/dev/null | $G -E 'import|require|from |spawn|exec|subprocess|system\(|Popen|\$`|Bun\.\$|run\(')
       imp=$(printf '%s\n' "$body" | $G -oE -m1 '(import|from|require)[^#]*(playwright|puppeteer|webkit|chromium)' | head -1)
       [ -n "$imp" ] && hits="$hits"$'\n'"browser	$imp	in $f"
       imp=$(printf '%s\n' "$body" | $G -oE -m1 '(import|from|require)[^#]*(ffmpeg|magick)' | head -1)
       [ -n "$imp" ] && hits="$hits"$'\n'"media	$imp	in $f" ;;
  esac
  more=$(classify "$body" "in $f"); [ -n "$more" ] && hits="$hits"$'\n'"$more"
done
hits=$(printf '%s\n' "$hits" | $G -v '^$')
[ -n "$hits" ] || exit 0
heavy=$(printf '%s\n' "$hits" | awk -F'\t' '$1 != "bypass"' | head -1)
bypass=$(printf '%s\n' "$hits" | awk -F'\t' '$1 == "bypass"' | head -1)

# (e) chi c'è davanti: errore o più di 2 s = umano (mai bloccare Attilio per un guasto qui)
if [ -n "${MAC_ATTENTION:-}" ]; then att="$MAC_ATTENTION"; why="${MAC_ATTENTION_WHY:-}"
else
  NODE=$(command -v node || echo /opt/homebrew/bin/node)
  r=$("$NODE" "${MAC_ATTENTION_BIN:-$HOME/Projects/claude-usage-hub/bin/mac-attention.mjs}" --why 2>/dev/null | head -1)
  att="${r%%$'\t'*}"; why=""; [ "$r" != "$att" ] && why="${r#*$'\t'}"
fi
case "$att" in human|background|delegated) ;; *) att=human ;; esac

say() { printf '%s\n' "$hits" | awk -F'\t' '{ printf "  %s: %s%s\n", $1, $2, ($3 != "" ? " (" $3 ")" : "") }'; }
record() {  # una riga per colpo in guard.jsonl
  mkdir -p "${LOG%/*}" 2>/dev/null
  jq -cn --argjson at "$(date +%s)000" --arg att "$att" --arg verdict "$1" --arg session "$sid" --arg hits "$hits" --arg cmd "${cmd:0:160}" \
    '{at:$at, attention:$att, verdict:$verdict, session:$session, cmd:$cmd, hits:($hits | split("\n") | map(split("\t") | {cls:.[0], text:.[1], where:(.[2] // "")}))}' >> "$LOG" 2>/dev/null || true
}

if [ "$att" = background ]; then
  record blocked
  cat >&2 <<EOF
Questa sessione non la guarda nessuno${why:+ ($why)}, e il comando è un lavoro pesante o una scorciatoia:
$(say)
Nelle sessioni in background il lavoro pesante passa dalla coda comune del Mac:
  offload --local -- <comando>   gira qui quando c'è un posto (gli stessi 3 dei gate di Topics), aspetta al massimo 8 min
  offload -- <comando>           va sul PC di casa (20 core): scrivilo per Windows, --get <cartella> per riportare i file
OFFLOAD=local e TOPICS_GATE_SLOTS=0 non valgono per le sessioni che nessuno guarda, e un'attesa fatta in casa
(while carico > N; sleep) non sostituisce la coda: il freno del Mac ferma comunque i lavori fuori coda.
EOF
  exit 2
fi

# human e delegated: come prima. Senza lavoro pesante, o con OFFLOAD=local davanti, si passa.
[ -n "$heavy" ] || exit 0
case "$cmd" in *OFFLOAD=local*) record passed; exit 0 ;; esac
strained=""; src=""
now=$(date +%s)
st=$(jq -r 'select(.at != null) | "\(.at) \(.strained)"' "$STATE" 2>/dev/null)
if [ -n "$st" ] && [ $(( now - ${st%% *} / 1000 )) -lt 90 ] 2>/dev/null; then
  [ "${st#* }" = true ] && strained=1; src="il hub lo dà sotto sforzo"
else
  load="${OFFLOAD_GUARD_LOAD:-$(/usr/sbin/sysctl -n vm.loadavg hw.ncpu 2>/dev/null | awk 'NR==1{l=$2} NR==2{printf "%.2f", l/$1}')}"
  awk -v l="$load" -v m="$max" 'BEGIN{exit !(l > m)}' && strained=1; src="carico $load per core, soglia $max"
fi
[ -n "$strained" ] || { record passed; exit 0; }
record blocked
cat >&2 <<EOF
Mac sotto sforzo ($src) e questo comando è pesante:
$(say)
Rilancialo sul PC di casa (20 core, si sveglia da solo): offload -- <comando>
- sul PC gira in cmd.exe: scrivilo per Windows; --mac-cmd "<cmd>" se sul Mac è diverso
- --get <cartella> per riportare report o risultati sul Mac
- la prima volta nel repo: offload -- "pnpm install --dangerously-allow-all-builds && <comando>"
Se deve girare per forza qui (servizi locali, Xcode, codex/moondream, output di build che serve
sul Mac), metti OFFLOAD=local davanti al comando. Trappole di Windows: ~/.claude/jarvis/memory/tools/pc-offload.md
EOF
exit 2
