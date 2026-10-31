#!/bin/bash
# Barra di kill-guard.py (e del suo aggancio in offload-guard.sh): pkill/pgrep/killall con opzioni
# dopo il pattern si fermano, il resto passa. La guardia non propone MAI una riga riscritta (giro 5): quando
# blocca spiega a parole. Poi i mutanti: se togliamo un pezzo, la barra deve diventare rossa.
# Uso: kill-guard-test.sh   (exit 0 = verde)
# Gira da solo dentro la gabbia senza segnali: un pkill vero partito per sbaglio non tocca i processi del Mac
if [ -z "${SENZA_SEGNALI:-}" ]; then
  [ -x "$HOME/bin/senza-segnali" ] || { echo "manca ~/bin/senza-segnali: non lancio la barra senza gabbia"; exit 1; }
  exec "$HOME/bin/senza-segnali" /bin/bash "$0" "$@"
fi
D="$(cd "$(dirname "$0")" && pwd)"
bad=0

run() { # $1 hook, $2 comando -> stampa deny|allow
  jq -n --arg c "$2" '{tool_input:{command:$c}}' | "$1" >/dev/null 2>&1
  [ $? = 2 ] && echo deny || echo allow
}
check() { # $1 hook, $2 atteso, $3 comando
  got=$(run "$1" "$3")
  [ "$got" = "$2" ] || { echo "SBAGLIATO ($got, atteso $2) [${1##*/}]: ${3:0:100}"; bad=1; }
}
msgof() { # $1 hook, $2 comando -> il messaggio della guardia
  jq -n --arg c "$2" '{tool_input:{command:$c}}' | "$1" 2>&1
}
noprop() { # $1 hook, $2 comando: deve fermarsi SENZA proporre nessuna riga (ne' rientrata, ne' con «Scrivilo»)
  m=$(msgof "$1" "$2")
  case "$m" in *Bloccato*) ;; *) echo "SBAGLIATO: non blocca [${1##*/}]: ${2:0:100}"; bad=1 ;; esac
  case "$m" in *"Scrivilo"*|*$'\n  '*|*"Riscrivilo"*) echo "SBAGLIATO: propone una riga [${1##*/}]: ${2:0:100}"; bad=1 ;; esac
}
suite() { # $1 hook
  H=$1
  # il caso vero del 25/10 16:36
  check "$H" deny  'pkill -f "^sleep 300$" -P 1'
  check "$H" deny  'pgrep -f foo -P 1'
  check "$H" deny  'pgrep -f "^zzz$" -P 1 | head -3'
  check "$H" deny  'pkill foo -9'
  check "$H" deny  'pkill -f node -x'
  check "$H" deny  'killall node -u root'
  check "$H" deny  'killall -s perl -u nobody'
  check "$H" deny  'sudo pkill -f foo -P 1'
  check "$H" deny  'timeout 5 pkill -f foo -P 1'
  check "$H" deny  'FOO=1 /usr/bin/pkill -f foo -P 1'
  check "$H" deny  'ls && pkill -f foo -P 1; echo ok'
  check "$H" deny  'bash -c "pkill -f foo -P 1"'
  check "$H" deny  'kill $(pgrep -f foo -P 1)'
  check "$H" deny  'kill "$(pgrep -f foo -P 1)"'
  check "$H" deny  'pkill -INT -f foo -P 1'
  check "$H" deny  'pkill -f foo -t ttys001'
  check "$H" deny  $'echo via\npkill foo -9'
  # scritti giusti, o che non sono un comando pkill
  check "$H" allow 'pkill -f -P 1 "^sleep 300$"'
  check "$H" allow 'pgrep -P 1 -f foo'
  check "$H" allow 'pkill -9 -f foo'
  check "$H" allow 'pkill -INT -f foo'
  check "$H" allow 'pkill -USR1 foo'
  check "$H" allow 'pkill -fP 1 foo'
  check "$H" allow 'pkill -f foo bar'
  check "$H" allow 'pkill -f -- "-foo"'
  check "$H" allow 'killall -u root node'
  check "$H" allow 'killall -s node'
  check "$H" allow 'killall -9 Dock'
  check "$H" allow 'pgrep -d, -f foo'
  check "$H" allow 'pgrep -fl node | head -n 1'
  check "$H" allow 'pgrep -f foo; ls -la'
  check "$H" allow 'git commit -m "fix: pkill foo -9 prende troppo"'
  check "$H" allow 'echo "pkill foo -9"'
  check "$H" allow 'grep -r pkill src --include=*.sh'
  check "$H" allow $'cat > /tmp/x.md <<\'EOF\'\nnon fare pkill foo -9\nEOF\nls'
  check "$H" allow 'ls -la'
  check "$H" allow 'pkill -f "unbalanced'
  # difetto 1: le redirezioni non sono argomenti (il caso intero del 25/10, con 2>/dev/null)
  check "$H" deny  'sleep 300 & sleep 2; pkill -f "^sleep 300$" -P 1 2>/dev/null; ps -ef | grep -c sleep'
  check "$H" deny  'pkill -f foo -P 1 2>&1'
  check "$H" deny  'pkill -f foo -P 1 >/dev/null 2>&1'
  check "$H" deny  'pkill -f foo -P 1 &>/dev/null | head'
  check "$H" deny  'pkill 2>/dev/null -f foo -P 1'
  check "$H" allow 'pkill -f -P 1 foo 2>/dev/null'
  check "$H" allow 'pgrep -f foo 2>&1 | head'
  check "$H" allow 'pkill foo > out.txt'
  check "$H" allow 'pkill -f foo bar 2>/dev/null; ls'
  # difetto 2a: un commento con apostrofo non spegne la guardia; un commento che nomina pkill non blocca
  check "$H" deny  $'# conto l\'elenco\npgrep -f \'^x$\' -P 1 | wc -l'
  check "$H" deny  $'echo ok # e\' fatto\npkill foo -9'
  check "$H" allow $'# non fare pkill foo -9\nls'
  check "$H" allow 'echo hi # pkill foo -9'
  check "$H" allow 'echo a#b; pkill -9 foo'
  # virgolette davvero aperte: si analizza la riga, o alla grossa
  check "$H" deny  $'echo "aperta\npkill foo -9'
  check "$H" deny  $'echo "aperta; pkill foo -9'
  # difetto 2b: riga spezzata con \ e a capo
  check "$H" deny  $'pkill -f foo \\\n  -P 1'
  check "$H" deny  $'pgrep -f \'^x$\' \\\n  -P 1 | wc -l'
  check "$H" deny  $'pkill \\\nfoo -9'
  check "$H" allow $'pkill -f -P 1 \\\n  foo'
  # il resto della riga dopo un heredoc e' comando vero
  check "$H" deny  $'cat <<EOF && pkill foo -9\ncorpo\nEOF'
  # difetto 3: -c e' una shell solo dopo sh/bash/zsh
  check "$H" allow 'grep -c "pkill -f foo -P 1" log.txt'
  check "$H" allow 'rg -c "pgrep foo -l" .'
  check "$H" deny  '/bin/zsh -c '"'"'pkill foo -9'"'"
  check "$H" deny  'sudo bash -c "pgrep foo -l"'
  check "$H" deny  'env FOO=1 sh -c "pkill foo -9"'
  check "$H" deny  'timeout 5 bash -lc "pkill foo -9"'
  check "$H" deny  'eval "pkill foo -9"'
  check "$H" deny  'kill `pgrep -f foo -P 1`'
  check "$H" allow 'bash -c "pkill -9 foo"'
  # difetto 4: due comandi, il primo giusto e il secondo sbagliato (il mutante continue->break)
  check "$H" deny  'pkill -f -P 1 foo; pkill -f bar -P 1'
  check "$H" deny  'pgrep -f -P 1 foo && killall node -u root'

  # giro 3, gravi: un `--` dopo il pattern e un `$(` spezzato non devono produrre una riga che prende centinaia di processi
  noprop "$H" "pkill -f '^zzz-nessuno\$' -- -P 1"
  noprop "$H" "pgrep -f '^zzz-nessuno\$' -- -x"
  noprop "$H" "pkill -f '^zzz-nessuno\$' -P 1 -- -l"
  noprop "$H" "pkill -f '^zzz-nessuno\$' -P 1 \$(echo)"
  # giro 3, medi: con qualunque espansione la guardia blocca e spiega, non propone
  noprop "$H" 'pkill -f "^x$" -P 1 $$'
  noprop "$H" 'pkill -f "^x$" -P 1 $!'
  noprop "$H" 'pkill -f x -P 1 $((1+1))'
  noprop "$H" 'pkill -f x -P 1 `echo`'
  noprop "$H" 'pkill -f x -P 1 ~'
  noprop "$H" 'pkill -f x -P 1 "$@"'
  noprop "$H" "pkill -f x -P 1 \$'a'"
  noprop "$H" 'pkill -f "$PAT" -P 1'
  noprop "$H" 'FOO=$(date) pkill -f x -P 1'
  # giro 3, medi: aggiramenti
  check "$H" deny  'pkill -f $(cat f) -P 1'
  check "$H" deny  'pkill -f `cat f` -P 1'
  check "$H" deny  $'bash <<\'X\'\npkill -f foo -P 1\nX'
  check "$H" deny  $'sh -s <<EOF\npkill foo -9\nEOF'
  check "$H" deny  $'cat <<\'EOF\' | bash\npkill foo -9\nEOF'
  check "$H" deny  'bash <<< "pkill foo -9"'
  check "$H" deny  'echo "pkill foo -9" | sh'
  check "$H" deny  'echo pkill foo -9 | sh'
  check "$H" deny  "printf '%s\\n' 'pkill foo -9' | bash -s"
  check "$H" deny  'xargs -I {} pkill -f {} -P 1'
  check "$H" deny  'bash -euo pipefail -c "pkill foo -9"'
  check "$H" deny  '/usr/bin/env pkill foo -9'
  check "$H" deny  '/usr/bin/sudo pkill foo -9'
  check "$H" deny  'sudo -u root pkill foo -9'
  check "$H" deny  'echo "$(pkill foo -9)"'
  check "$H" deny  $'cat <<EOF\n$(pkill foo -9)\nEOF'
  check "$H" allow 'cat f | bash'
  check "$H" allow 'echo "pkill foo -9" | cat'
  check "$H" allow $'cat <<\'EOF\' | cat\npkill foo -9\nEOF'
  check "$H" allow $'bash ok.sh <<\'EOF\'\npkill foo -9\nEOF'
  check "$H" allow $'cat <<\'EOF\'\n$(pkill foo -9)\nEOF'
  # giro 3, medi: testo tra apici singoli, backtick escapati e heredoc con delimitatori strani sono dati
  check "$H" allow "git commit -m 'blocca \`pkill -f foo -P 1\`'"
  check "$H" allow "grep -n 'kill \$(pgrep -f foo -P 1)' note.md"
  check "$H" allow "echo 'da non fare: \$(pkill -f foo -P 1)' >> note.md"
  check "$H" allow "echo '\$(pkill foo -9)'"
  check "$H" allow 'echo "\`pkill -f foo -P 1\`"'
  check "$H" allow $'cat > n.md <<\\EOF\nnote\npkill foo -9\nEOF'
  check "$H" allow $'cat <<END-DOC\nnote\npkill foo -9\nEND-DOC'
  check "$H" allow $'cat <<-EOF\n\tnote\n\tpkill foo -9\n\tEOF\nls'
  check "$H" deny  $'cat <<\\EOF && pkill foo -9\ncorpo\nEOF'

  # giro 4, medi: `-DP`, `-DU`, `-IP` non sono segnali, pkill li legge come `-D -P <parola dopo>`
  noprop "$H" 'pkill 1 -DP'
  noprop "$H" 'pkill root -DU'
  noprop "$H" 'pgrep 1 -IP'
  noprop "$H" 'pkill foo -HUP'
  noprop "$H" 'pkill foo -SIGTERM'
  noprop "$H" 'pkill foo -15'
  # giro 4, medi: graffe, sostituzione di processo e `~` dopo `=`
  noprop "$H" 'pkill -f x -P 1 {1,2}'
  noprop "$H" 'pkill -f x{a,b} -P 1'
  noprop "$H" 'A=~/x pkill -f x -P 1'
  noprop "$H" 'pkill -f x -P 1 <(echo)'
  noprop "$H" "pkill -f x -P 1 '{1,2}'"
  noprop "$H" "{ pkill -f x -P 1; }"
  # giro 4, medi: l'idioma dei messaggi di commit (heredoc con apostrofi dentro `$(...)`) e' testo
  check "$H" allow $'git commit -m "$(cat <<\'EOF\'\nkill-guard: l\'ultimo caso\n\npkill -f x -P 1 prendeva tutto\nEOF\n)"'
  check "$H" allow $'gh pr create --title t --body "$(cat <<\'EOF\'\nl\'opzione dopo il pattern\npgrep foo -l\nEOF\n)"'
  check "$H" allow $'git commit -m "$(cat <<-\'EOF\'\n\tl\'ultimo: pkill foo -9\n\tEOF\n)"'
  check "$H" allow $'git commit -m "$(cat <<EOF\nl\'ultimo: pkill foo -9\nEOF\n)"'
  check "$H" deny  $'git commit -m "$(cat <<\'EOF\'\nl\'ultimo\nEOF\n)"; pkill foo -9'
  check "$H" deny  $'echo "$(cat <<\'EOF\'\nl\'ultimo\nEOF\npkill foo -9\n)"'
  check "$H" deny  $'git commit -m "$(cat <<EOF\nl\'ultimo: $(pkill foo -9)\nEOF\n)"'
  # giro 4, medi: la stringa di trap la esegue la shell all'uscita
  check "$H" deny  "trap 'pkill -f x -P 1' EXIT"
  check "$H" deny  "trap -- 'pkill foo -9' INT TERM"
  noprop "$H" 'trap "pkill -f myserver -P $$" EXIT'
  noprop "$H" "trap 'pkill -f myserver -P \$\$' EXIT"
  check "$H" allow "trap 'pkill -f -P 1 x' EXIT"
  check "$H" allow "trap 'rm -f tmp' EXIT"
  check "$H" allow "trap - EXIT"

  # giro 5, GRAVE: la guardia non propone mai una riga. Prima, `$(echo)` dentro bash -c, eval, trap, heredoc, here-string
  # o `echo "..." | sh` veniva letto come testo e proposto come pattern '$' (509 processi); `-P '$$'` uguale
  noprop "$H" 'bash -c "pkill -f x -P 1 \$(echo)"'
  noprop "$H" 'eval "pkill -f x -P 1 \$(echo)"'
  noprop "$H" "trap 'pkill -f x -P 1 \$(echo)' EXIT"
  noprop "$H" $'bash <<EOF\npkill -f x -P 1 \\$(echo)\nEOF'
  noprop "$H" $'bash <<\'EOF\'\npkill -f x -P 1 $(echo)\nEOF'
  noprop "$H" 'bash <<< "pkill -f x -P 1 \$(echo)"'
  noprop "$H" 'echo "pkill -f x -P 1 \$(echo)" | sh'
  noprop "$H" 'echo pkill -f x -P 1 \$\(echo\) | sh'
  noprop "$H" "pkill -f x -P '\$\$'"
  noprop "$H" 'pkill -f x -P \$\$'
  noprop "$H" 'pkill -f x -P "$$"'
  noprop "$H" 'bash -c "pkill -f x -P \$\$"'
  noprop "$H" 'pkill -f "^x$" -P 1'
  noprop "$H" 'pgrep -f foo -P 1 2>/dev/null'
  noprop "$H" 'pkill -f x -P 1 > /dev/null'
  # giro 5, MEDIO: le sostituzioni nel bersaglio di una redirezione o di una here-string si leggono
  check "$H" deny  'xargs kill <<< "$(pgrep -f foo -P 1)"'
  check "$H" deny  'xargs kill <<< $(pgrep -f foo -P 1)'
  check "$H" deny  'xargs kill <<< `pgrep -f foo -P 1`'
  check "$H" deny  'xargs kill <<<"$(pgrep -f foo -P 1)"'
  check "$H" deny  'cat > "$(pkill foo -9)"'
  check "$H" deny  'cat >> "$(pgrep -f foo -P 1)".log'
  check "$H" deny  'cat < "$(pgrep -f foo -P 1)"'
  check "$H" deny  'cat <<< "$(echo "$(pgrep -f foo -P 1)")"'
  check "$H" deny  'cat <<< "a $(echo x) b $(pgrep -f foo -P 1)"'
  check "$H" deny  'cat <<< "$(bash -c '"'"'pkill foo -9'"'"')"'
  check "$H" deny  'echo "$(pgrep -f foo -P 1)"'
  check "$H" deny  'echo "x $(pkill -f foo -P 1 2>/dev/null) y"'
  check "$H" deny  $'cat <<EOF\n"$(pgrep -f foo -P 1)"\nEOF'
  check "$H" allow 'xargs kill <<< "$(pgrep -f -P 1 foo)"'
  check "$H" allow 'xargs kill <<< "$(pgrep -f foo)"'
  check "$H" allow "xargs kill <<< '\$(pgrep -f foo -P 1)'"
  check "$H" allow 'cat <<< "pgrep -f foo -P 1"'
  check "$H" allow 'cat > "$(date).log"'
  check "$H" allow 'n=$(grep -c '"'"'pkill foo -9'"'"' log.txt)'
  check "$H" allow 'n=$(pgrep -fl node | wc -l)'
  check "$H" allow $'cat > n.md <<\'EOF\'\n$(pgrep -f foo -P 1)\nEOF'
  check "$H" allow 'echo "# $(date)" # pgrep -f foo -P 1'
  # controllo di riserva: dentro una sostituzione basta nominarlo (anche dietro un comando che l'analisi non conosce)
  check "$H" deny  'x=$(mywrap pkill foo -9)'
  check "$H" deny  'cat <<< "$(someruntime pgrep -f foo -P 1)"'
  check "$H" deny  'x="$(echo pkill foo -9)"'
  check "$H" allow 'mywrap pkill -f -P 1 foo'
  # giro 6: il pattern fra apici singoli dietro un wrapper sconosciuto dentro $(...) (il controllo di riserva legge le virgolette)
  check "$H" deny  'kill $(noglob pgrep -f '"'"'^sleep 300$'"'"' -P 1)'
  check "$H" deny  'xargs kill <<< "$(gtimeout 5 pgrep -f '"'"'^sleep 300$'"'"' -P 1)"'
  check "$H" deny  'x=$(mywrap pkill -f '"'"'^x$'"'"' -P 1)'
  check "$H" deny  'x=`mywrap pkill -f '"'"'^x$'"'"' -P 1`'
  check "$H" deny  'x=$(echo "$(mywrap pkill -f '"'"'^x$'"'"' -P 1)")'
  check "$H" deny  'x=$(mywrap /usr/bin/pgrep -f "^x$" -P 1 2>/dev/null | head -1)'
  check "$H" allow 'x=$(mywrap pkill -f -P 1 '"'"'^x$'"'"')'
  check "$H" allow 'kill $(noglob pgrep -P 1 -f '"'"'^sleep 300$'"'"')'
  check "$H" allow 'x=$(echo '"'"'pkill foo -9'"'"')'
  check "$H" allow 'x=$(pgrep -fl node 2>/dev/null | head -n 1)'
  check "$H" allow 'for p in $(pgrep -f '"'"'^sleep 300$'"'"'); do echo $p; done'
  # giro 6: `function nome { ... }` (la forma con () si fermava gia')
  check "$H" deny  'function cleanup { pkill -f '"'"'^sleep 300$'"'"' -P 1; }; cleanup'
  check "$H" deny  $'function cleanup\n{\n  pkill -f foo -P 1\n}\ncleanup'
  check "$H" deny  'function cleanup() { pkill -f foo -P 1; }; cleanup'
  check "$H" allow 'function cleanup { pkill -f -P 1 '"'"'^sleep 300$'"'"'; }; cleanup'
  # giro 7, GRAVE: il controllo di riserva legge il testo PULITO (heredoc e apici sono testo). Il giro 6 leggeva il
  # grezzo e fermava la forma di commit di Claude Code: i messaggi veri di 8b3b214 e di jarvis 2890430
  check "$H" allow $'git commit -m "$(cat <<\'EOF\'\nkill-guard: pkill/pgrep/killall con opzioni dopo il pattern si fermano (25/10, pkill -f x -P 1 ha ucciso il gateway)\nEOF\n)"'
  check "$H" allow $'git commit -m "$(cat <<\'EOF\'\ncron-health: segnala il cron che cerca il gateway con pgrep senza -a\n\nIl 24/10 alle 09:30 pgrep su macOS esclude i propri antenati.\nEOF\n)"'
  check "$H" allow $'git commit -m "$(cat <<\'EOF\'\nl\'incidente: pkill -f "^sleep 300$" -P 1\nEOF\n)"'
  # giro 7, MEDIO: parole fra apici usate come argomento dentro $(...) sono testo
  check "$H" allow 'n=$(grep -rn '"'"'pkill'"'"' . --include='"'"'*.sh'"'"' | wc -l)'
  check "$H" allow 'x=$(rg '"'"'pkill'"'"' src -l)'
  check "$H" allow 'n=$(grep -c "pgrep" hooks/kill-guard.py -r)'
  check "$H" allow 'for f in $(rg -l '"'"'killall'"'"' src -g '"'"'*.ts'"'"'); do echo $f; done'
  # giro 7: un pattern fra virgolette doppie e' una parola sola (giri 5 e 6 fermavano questi comandi veri del corpus)
  check "$H" allow 'P=$(pgrep -f "codex exec -m gpt-5.6-luna" | head -1); [ -n "$P" ] && caffeinate -w $P'
  check "$H" allow 'ps -o pid,etime -p $(pgrep -f "node --max-old-space-size=1800 pass1.mjs")'
  check "$H" allow 'for p in $(pgrep -f "claude -p"); do echo $p; done'
  check "$H" allow 'TPID=$(pgrep -f "ssh -f -N .*127.0.0.1:3250:127.0.0.1:3250" | head -1)'
  # giro 7: restano fermi (wrapper sconosciuto dentro $(...), function NOME, e i comandi veri del corpus)
  check "$H" deny  'kill $(noglob pgrep -f x -P 1)'
  check "$H" deny  'function cleanup { pkill -f x -P 1; }; cleanup'
  check "$H" deny  'echo "6) $(senza-segnali /usr/bin/pkill -f '"'"'^zzz-nessuno$'"'"' -P 1 2>&1 | wc -l)"'
  check "$H" deny  'pkill -9 -f "dispatch" -U $(id -u) 2>/dev/null'
  check "$H" deny  'pgrep -x bun -l'
  check "$H" deny  'pkill -f "perf-quiete.sh" -n 2>/dev/null'
  check "$H" deny  'N=$(pgrep -f "^zzz-nessuno$" -P 1 2>/dev/null | wc -l)'
  # giro 7: `$'...'` (stringa alla C) con `\'` dentro non sfasa le virgolette di tutto il comando
  check "$H" allow "echo \$'l\\'ultimo'; echo \"pkill foo -9\""
  check "$H" allow $'run $\'pgrep -f "^x$" \\\\\\n -P 1\'; cat <<\'EOF\'\nnota: pkill -f x -P 1\nEOF'
  check "$H" deny  "echo \$'l\\'ultimo'; pkill foo -9"
  check "$H" deny  "bash -c \$'pkill foo -9'"
  check "$H" deny  "pkill -f \$'a\\nb' -P 1"
  check "$H" deny  "x=\$(echo \$'it\\'s'; pgrep -f x -P 1)"
  # testo che non si legge (sostituzione mai chiusa): si guardano le parole, la guardia non cade
  check "$H" deny  'pkill foo -9 $('
  check "$H" deny  'echo "$(" ; pgrep -f foo -P 1 `'
}

suite "$D/kill-guard.py"

# aggancio: offload-guard.sh lo chiama per primo, anche a Mac scarico, e con l'input nudo di jcode
OG="$D/offload-guard.sh"
check "$OG" deny  'pkill -f "^sleep 300$" -P 1'
check "$OG" allow 'pkill -f -P 1 "^sleep 300$"'
check "$OG" deny  'killall node -u root'
check "$OG" allow 'killall -u root node'
check "$OG" allow 'ls -la'
got=$(printf '%s' '{"command":"pgrep -f foo -P 1"}' | JCODE_HOOK_TOOL_NAME=bash "$OG" >/dev/null 2>&1; echo $?)
[ "$got" = 2 ] || { echo "SBAGLIATO jcode bash: exit $got, atteso 2"; bad=1; }
got=$(printf '%s' '{"command":"pgrep -f foo -P 1"}' | JCODE_HOOK_TOOL_NAME=read "$OG" >/dev/null 2>&1; echo $?)
[ "$got" = 0 ] || { echo "SBAGLIATO jcode altro strumento: exit $got, atteso 0"; bad=1; }

# il messaggio spiega a parole e dà lo schema generico, mai una riga riscritta
kmsg() { msgof "$D/kill-guard.py" "$1"; }
for c in 'pkill -f "^sleep 300$" -P 1' 'sleep 300 & sleep 2; pkill -f "^sleep 300$" -P 1 2>/dev/null; ps -ef | grep -c sleep' 'pgrep -f foo -P 1 2>&1' 'kill $(pgrep -f foo -P 1)' 'xargs kill <<< "$(pgrep -f foo -P 1)"'; do
  msg=$(kmsg "$c")
  case "$msg" in *"pkill [opzioni] -f 'pattern'"*"PID"*) ;; *) echo "SBAGLIATO: manca lo schema generico per: $c"; bad=1 ;; esac
  case "$msg" in *"Scrivilo"*|*$'\n  '*|*"Riscrivilo"*) echo "SBAGLIATO: il messaggio propone una riga per: $c"; bad=1 ;; esac
done

# aggancio killall senza pkill/pgrep: il prefiltro di offload-guard deve nominarlo
# mutanti: la barra deve cadere se (1) togliamo il blocco, (2) il primo segmento giusto ferma l'analisi
# degli altri (continue->break), (3) killall esce dal prefiltro di offload-guard
if [ -z "$KILL_GUARD_MUTANT" ]; then
  tmp=$(mktemp -d)
  mutant() { # $1 nome, $2 file mutato -> la suite deve stampare almeno un errore
    chmod +x "$2"
    m=$(KILL_GUARD_MUTANT=1 bash -c "$(declare -f run check msgof noprop suite); D='$D'; bad=0; suite '$2'; exit \$bad" 2>&1 | wc -l)
    [ "$m" -gt 0 ] || { echo "MUTANTE SOPRAVVISSUTO: $1"; bad=1; }
  }
  sed 's/return 2/return 0/' "$D/kill-guard.py" > "$tmp/kill-guard.py"
  mutant "senza il blocco la barra resta verde" "$tmp/kill-guard.py"
  perl -0pe 's/(if not after:\s*)continue/$1break/' "$D/kill-guard.py" > "$tmp/kg-break.py"
  cmp -s "$tmp/kg-break.py" "$D/kill-guard.py" && { echo "MUTANTE NON APPLICATO: continue->break"; bad=1; }
  mutant "continue->break in main() resta verde" "$tmp/kg-break.py"
  # senza il controllo di riserva sul testo grezzo, senza le sostituzioni delle redirezioni, senza la lettura
  # dello stdin delle shell... la barra deve cadere
  mut() { # $1 nome, $2 sed, $3 file
    sed "$2" "$D/kill-guard.py" > "$tmp/$3"
    cmp -s "$tmp/$3" "$D/kill-guard.py" && { echo "MUTANTE NON APPLICATO: $1"; bad=1; return; }
    mutant "$1" "$tmp/$3"
  }
  mut "senza il controllo di riserva sul testo grezzo" 's/^    found += raw_backup(cmd)$/    pass/' kg-backup.py
  mut "il controllo di riserva non pulisce gli apici singoli" 's/^        if not dq and c == "\x27":/        if False:/' kg-rawsq.py
  mut "le sostituzioni delle redirezioni non si estraggono" 's/^                subs += \[raw for raw, _ in walk.*$/                pass/' kg-redir.py
  mut "word_end non conosce le virgolette con \$( dentro" 's/^        elif ch == \x27"\x27:$/        elif False:/' kg-wend.py
  mut "match_paren non salta i corpi degli heredoc" 's/^        if text.startswith("<<", j) and not text.startswith("<<<", j):/        if False:/' kg-hd.py
  # giro 7: i corpi degli heredoc tornano comandi (il GRAVE del giro 6), o le virgolette non si leggono piu'
  mut "walk non cancella i corpi degli heredoc (tornano comandi)" 's/^                    blank(i, nxt)$/                    pass/' kg-hdbody.py
  mut "il controllo di riserva legge il testo grezzo invece del pulito" 's/^        hits += clean_words(clean)$/        hits += clean_words(raw)/' kg-rawtext.py
  mut "il controllo di riserva non legge le virgolette (alla grossa)" 's/^        toks = lex(clean.replace("\\n", " ; "))$/        raise ValueError/' kg-noshlex.py
  mut "prepare non conosce \$'...'" 's/^        if text.startswith("\$\x27", i):$/        if False:/' kg-ansi.py
  mut "command_start non salta function NOME" 's/elif w == "function":/elif False:/' kg-function.py
  mut "senza trap" 's/elif base == "trap":/elif False:/' kg-trap.py
  mut "senza lo stdin delle shell" 's/if ci < len(seg) and reads_script_from_stdin(seg, ci):/if False:/' kg-stdin.py
  mut "senza i wrapper col percorso (basename)" 's/b = os.path.basename(w)/b = w/' kg-base.py
  mut "backtick e \$( dentro gli apici singoli tornano codice" 's/if q == "\x27":/if False:/' kg-sq.py
  mkdir "$tmp/og"; cp "$D/kill-guard.py" "$tmp/og/"; sed 's/|\*killall\*//' "$OG" > "$tmp/og/offload-guard.sh"; chmod +x "$tmp/og/offload-guard.sh"
  cmp -s "$tmp/og/offload-guard.sh" "$OG" && { echo "MUTANTE NON APPLICATO: killall dal prefiltro"; bad=1; }
  [ "$(run "$tmp/og/offload-guard.sh" 'killall node -u root')" = deny ] && { echo "MUTANTE SOPRAVVISSUTO: senza *killall* nel prefiltro killall passa lo stesso"; bad=1; }
  trash "$tmp" 2>/dev/null
fi

[ $bad = 0 ] && echo "kill-guard ok"; exit $bad
