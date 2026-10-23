#!/bin/sh
# I due mutanti di feedback.mjs devono far fallire il test, o il test non li prende.
set -e
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM HUP
cp -R src test package.json "$tmp/"
orig="$tmp/orig-feedback.mjs"
cp "$tmp/src/automations/feedback.mjs" "$orig"
caught=0

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
