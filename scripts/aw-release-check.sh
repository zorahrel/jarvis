#!/bin/bash
# Controllo settimanale (cron OpenClaw, lunedì 10:00): è uscita una release di ActivityWatch che contiene
# la coda di heartbeat di aw-watcher-window (#162) e il fix del crash all'avvio (#172)?
# Finché no: NO_REPLY (non parte niente). Quando sì: una riga ad Attilio, perché la nostra build 0.13.2 con
# heartbeat-seriale.patch si può sostituire con la release (poi va riconcessa a mano l'Accessibilità).
# Contesto: jarvis/private/research/2026-10-27-censimento/PIANO.md, voce ActivityWatch. Exit != 0 solo se GitHub non risponde.
set -u
R=ActivityWatch/aw-watcher-window
tag=$(gh api repos/ActivityWatch/activitywatch/releases/latest --jq .tag_name) || exit 2
sub=$(gh api "repos/ActivityWatch/activitywatch/contents/aw-watcher-window?ref=$tag" --jq .sha) || exit 2
m162=$(gh pr view 162 -R $R --json mergeCommit --jq '.mergeCommit.oid // ""') || exit 2
m172=$(gh pr view 172 -R $R --json mergeCommit --jq '.mergeCommit.oid // ""') || exit 2
in_release() { [ -n "$1" ] && [ "$(gh api "repos/$R/compare/$1...$sub" --jq .status)" != "behind" ] && \
  [ "$(gh api "repos/$R/compare/$1...$sub" --jq .status)" != "diverged" ]; }
if in_release "$m162" && in_release "$m172"; then
  echo "ActivityWatch $tag contiene la coda degli heartbeat e il fix del crash: la nostra build 0.13.2 con la patch si può sostituire. Lo faccio io, a te resta solo riconcedere l'Accessibilità dopo la build."
else
  echo "NO_REPLY"
fi
