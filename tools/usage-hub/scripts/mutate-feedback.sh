#!/bin/sh
# I due mutanti di feedback.mjs devono far fallire il test, o il test non li prende.
set -e
cd "$(dirname "$0")/.."
# mktemp -d da solo su macOS ignora TMPDIR: la copia finiva fuori dal TMPDIR della barra
tmp="$(mktemp -d "${TMPDIR:-/tmp}/mutate.XXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM HUP
# la copia deve poter girare il test: giro 9 copiava solo src e test, ERR_MODULE_NOT_FOUND e «mutante preso» sempre
cp -R src test test-support public modules package.json "$tmp/"
orig="$tmp/orig-feedback.mjs"
cp "$tmp/src/automations/feedback.mjs" "$orig"
caught=0
# la copia senza mutanti dev'essere verde, se no un rosso dei mutanti non vuol dire niente
(cd "$tmp" && node --test test/automations-feedback.test.mjs > "$tmp/base.log" 2>&1) || {
  echo 'ROSSO la copia senza mutanti non passa il test: i mutanti non proverebbero niente'; tail -20 "$tmp/base.log"; exit 1; }

# (a) vince il primo voto invece dell'ultimo.
cp "$orig" "$tmp/src/automations/feedback.mjs"
sed '/mutante:a/ s/>=/</' "$tmp/src/automations/feedback.mjs" > "$tmp/mut.mjs"
mv "$tmp/mut.mjs" "$tmp/src/automations/feedback.mjs"
if cmp -s "$orig" "$tmp/src/automations/feedback.mjs"; then
  echo 'mutante a non applicato'
  exit 1
fi
if (cd "$tmp" && node --test test/automations-feedback.test.mjs > /dev/null 2>&1); then
  echo 'mutante a non preso'
  exit 1
else
  echo 'mutante a preso'
  caught=$((caught + 1))
fi

# (b) il silenzio non scade mai.
cp "$orig" "$tmp/src/automations/feedback.mjs"
sed '/mutante:b/ s/Date\.parse(last\.until) > now/true/' "$tmp/src/automations/feedback.mjs" > "$tmp/mut.mjs"
mv "$tmp/mut.mjs" "$tmp/src/automations/feedback.mjs"
if cmp -s "$orig" "$tmp/src/automations/feedback.mjs"; then
  echo 'mutante b non applicato'
  exit 1
fi
if (cd "$tmp" && node --test test/automations-feedback.test.mjs > /dev/null 2>&1); then
  echo 'mutante b non preso'
  exit 1
else
  echo 'mutante b preso'
  caught=$((caught + 1))
fi

echo "mutanti presi: $caught/2"
