#!/bin/sh
# copia ridotta della barra del 24/10 alle 13:34 (refute-r4): i gate di Topics in fila, con tutte e due le scorciatoie
cd /tmp/refute-r4-git || exit 2
git add -A
for g in check:comment-language check:emdash typecheck:server typecheck:client; do
  /tmp/refute-r4-tools/waitload.sh
  OFFLOAD=local TOPICS_GATE_SLOTS=0 ~/bin/capped 4096 600 -- bun run $g > /tmp/refute-r4-tools/gate-$g.log 2>&1
  echo "$g exit $?"
done
