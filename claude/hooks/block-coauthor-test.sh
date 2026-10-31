#!/bin/bash
# Barra di block-coauthor.sh: i trailer veri si bloccano, la regola che li vieta no.
H="$(dirname "$0")/block-coauthor.sh"; bad=0
T1=$'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
T2=$'co-authored-by: Someone <someone@example.com>'
G1=$'🤖 Generated with [Claude Code](https://claude.com/claude-code)'
G2=$'Generated with [Claude Code](https://claude.com/claude-code)'
t() { # $1 atteso (deny|allow), $2 comando
  out=$(jq -n --arg c "$2" '{tool_input:{command:$c}}' | "$H")
  got=allow; echo "$out" | grep -q '"deny"' && got=deny
  [ "$got" = "$1" ] || { echo "SBAGLIATO ($got, atteso $1): ${2:0:90}"; bad=1; }
}
t deny  "git commit -m \"fix"$'\n\n'"$T1\""
t deny  "git -C /tmp/x commit -m \"fix"$'\n\n'"$T2\""
t deny  "gh pr create --title x --body \"corpo"$'\n\n'"$G1\""
t deny  "gh pr create --title x --body \"$G2\""
# 24/10: il compito per delegate contiene la regola che vieta i trailer, non un trailer
t allow 'delegate -C /tmp/wt "Scrivi il fix, poi git commit e gh pr create. Regole: no Co-Authored-By trailer, no \"Generated with\" line."'
t allow 'delegate -C /tmp/wt "git commit senza trailer Co-Authored-By: e senza la riga \"Generated with Claude Code\""'
t allow 'git commit -m "fix: niente trailer"'
t allow 'ls -la'
[ $bad = 0 ] && echo "block-coauthor ok"; exit $bad
