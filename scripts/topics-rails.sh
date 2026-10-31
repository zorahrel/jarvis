#!/bin/zsh
# Barra statica di una worktree: typecheck, lint, i check:* statici (dopo il commit: leggono git ls-files).
emulate -L zsh
cd "$1" || exit 2
export PATH="$HOME/.topics/bun/1.4.2:$PATH"
bun run typecheck >/dev/null 2>&1 && echo "typecheck ok" || echo "ROSSO: typecheck"
bun run lint >/dev/null 2>&1 && echo "lint ok" || echo "ROSSO: lint"
echo "non aggiunti: $(git status --porcelain | /usr/bin/grep -c '^??')"
red=0
for c in any any-budget nul api-door emdash comment-language identifier-language eslint-disable test-skips module-mock-restore sleeps tmp-canonical bloat route-shadowing security spec-coverage untraced-tests deadcode deadcode-blindspots ui-language typography lockfile; do
  out="$(bun run check:$c 2>&1)" || { echo "ROSSO: check:$c"; print -r -- "$out" | tail -15; red=$((red+1)); }
done
echo "static rossi=$red"
