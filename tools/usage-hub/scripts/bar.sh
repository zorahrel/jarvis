#!/bin/sh
# Barra dell'hub e della scheda Automazioni: un comando, sempre uguale, esce non zero al primo rosso.
#   npm run bar
set -e
cd "$(dirname "$0")/.."
# tutta la barra ha un TMPDIR suo: alla fine dev'essere vuoto (demo, ui-bar, prove e test non lasciano niente)
BT="$(mktemp -d)"; export TMPDIR="$BT/"
# 1. ciò che è verde resta verde: tutti i test con HOME e TMPDIR finti, sentinelle nei file veri, niente lasciato in $TMPDIR
sh scripts/tmp-leak-check.sh
node modules/tray/server/test.mjs
node --test modules/tray/assets/bar-icons.test.mjs
sh scripts/check-modules.sh
python3 -m pytest -q modules/tray/server/test_muse_probe.py
# 2. i test nuovi ci sono ancora per nome (girano nel passo 1, isolati: qui un file rinominato o sparito fa rosso)
for f in automations-sources automations-sources-more automations-levels automations-feedback automations-feedback-import \
  automations-api automations-view automations-queue automations-falsi-verdi dashboard-parity dashboard-actions no-ids demo-isolation; do
  [ -f "test/$f.test.mjs" ] || { echo "ROSSO test/$f.test.mjs sparito"; exit 1; }
done
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
# 7. la prova della scheda Automazioni (due demo, layout a 375, axe): era fuori dalla barra ed era rossa
python3 scripts/prova-automazioni.py
# 8. niente lasciato nel TMPDIR della barra, niente processi demo vivi
left="$(ls -A "$BT")"; [ -z "$left" ] || { echo "ROSSO la barra ha lasciato in TMPDIR: $(echo $left)"; exit 1; }
# ps eww mostra anche l'ambiente: senza TMPDIR per ps e foto su file, il controllo non trova sé stesso (awk e
# grep della pipeline ereditano il TMPDIR della barra e facevano un falso rosso)
sleep 2; PS="${BT%/}.ps"
env -u TMPDIR ps eww -ax -o pid=,command= > "$PS"
alive="$(env -u TMPDIR awk -v bt="$BT" -v me="$$" 'index($0, bt) && $1 != me {print $1}' "$PS")"; rm -f "$PS"
[ -z "$alive" ] || { echo "ROSSO processi della barra ancora vivi: $(echo $alive)"; kill -9 $alive 2>/dev/null; exit 1; }
rmdir "$BT"
echo 'BARRA VERDE'
