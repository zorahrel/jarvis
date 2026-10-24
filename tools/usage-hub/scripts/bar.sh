#!/bin/sh
# Barra dell'hub e della scheda Automazioni: un comando, sempre uguale, esce non zero al primo rosso.
#   npm run bar
set -e
cd "$(dirname "$0")/.."
# 1. ciò che è verde resta verde: tutti i test con HOME e TMPDIR finti, sentinelle nei file veri, niente lasciato in $TMPDIR
sh scripts/tmp-leak-check.sh
node modules/tray/server/test.mjs
node --test modules/vdm/test/
node --test modules/tray/assets/bar-icons.test.mjs
sh scripts/check-modules.sh
python3 -m pytest -q modules/tray/server/test_muse_probe.py
node --test test/dashboard-parity.test.mjs
# 2. i test nuovi per nome (sono anche in npm test: qui un file rinominato o sparito fa rosso)
node --test test/automations-sources.test.mjs test/automations-sources-more.test.mjs test/automations-levels.test.mjs \
  test/automations-feedback.test.mjs test/automations-feedback-import.test.mjs test/automations-api.test.mjs \
  test/automations-view.test.mjs test/automations-queue.test.mjs test/automations-falsi-verdi.test.mjs
# 3. i mutanti del feedback devono essere presi
sh scripts/mutate-feedback.sh
# 4. il feedback finisce cifrato (l'attributo; la prova sul blob la fa il cron una tantum dopo il primo commit notturno)
git -C "$HOME/.claude/jarvis/private" check-attr filter -- automazioni/feedback/2026-10.jsonl | grep -q 'filter: git-crypt' \
  || { echo 'ROSSO automazioni/feedback non è cifrato da git-crypt'; exit 1; }
# T6: «Lavori a orario» si è spostato, non duplicato
[ "$(/usr/bin/grep -c 'Lavori a orario' public/app.js)" = 0 ] || { echo 'ROSSO «Lavori a orario» ancora in app.js'; exit 1; }
# T8: tre aperti noti, la CLI ne vede tre
n=$(USAGE_HUB_FEEDBACK_DIR=test/fixtures/feedback-3-aperti node bin/usage-hub.mjs feedback --open --json | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>console.log(JSON.parse(s).length))')
[ "$n" = 3 ] || { echo "ROSSO feedback --open vede $n aperti invece di 3"; exit 1; }
agents-doctor >/dev/null || { echo 'ROSSO agents-doctor'; exit 1; }
# 5. misure su un serve a parte (il :3360 vivo non si tocca)
node scripts/measure-automations.mjs --demo
node scripts/measure-automations.mjs --live
# 6. UI: nav intera cambiando tab, niente tagli, ui-audit e axe a 0 a 1440, 700 e 375 (serve --demo a parte)
python3 scripts/ui-bar.py
echo 'BARRA VERDE'
