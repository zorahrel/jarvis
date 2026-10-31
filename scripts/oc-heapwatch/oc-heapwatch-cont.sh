#!/bin/zsh
# Profili di heap del gateway OpenClaw uno dietro l'altro (24 x 15 min = 6 h, senza buchi), per legare
# la memoria che resta alle ricostruzioni dei plugin (23/10). Il gateway accetta un profilo alla volta
# («busy»): si aspetta che finisca quello del job orario, poi lo si ferma e si prende il posto.
export PATH=/opt/homebrew/bin:$PATH
OUT=~/.cache/oc-heapwatch/cont; mkdir -p $OUT
CAP=~/.openclaw/tmp/plugin-captures
uid=$(id -u)
while [[ -n $(print -l ~/.cache/oc-heapwatch/*.json.tmp(N)) ]]; do sleep 10; done
# --- quiet-begin
# Finestra dell'update di OpenClaw (openclaw-safe-update, launchd 04:20): fra le 04:00 e le 06:30 non parte
# nessuna finestra di profilo, perche' il riavvio del gateway la spezzerebbe e l'update, vedendola in corso,
# aspetta (25/10: bloccato fino alle 06:15). Alle 06:30 riprende da solo. Una finestra partita prima delle
# 04:00 finisce entro le 04:15, e l'update se ne accorge (cerca la chiamata diagnostics.heapProfile).
# Secondi da aspettare, 0 fuori finestra. OC_QUIET_NOW_S (secondi da mezzanotte) serve solo al test.
quiet_left() {
  local now=${OC_QUIET_NOW_S:-$(( 10#$(date +%H) * 3600 + 10#$(date +%M) * 60 + 10#$(date +%S) ))}
  if (( now >= 4 * 3600 && now < 6 * 3600 + 1800 )); then print $(( 6 * 3600 + 1800 - now )); else print 0; fi
}
quiet_wait() { local w; while (( (w = $(quiet_left)) > 0 )); do sleep $w; done; }
# --- quiet-end
launchctl bootout gui/$uid/com.jarvis.oc-heapwatch 2>/dev/null
# 48 finestre da 15 min = 12 h. La versione va in ogni riga: l'update a 2026.10.6 dividerà la serie
for (( i=1; i<=${OC_WINDOWS:-48}; i++ )); do
  quiet_wait
  start=$(date +%FT%T)
  f=$OUT/$(date +%Y%m%d-%H%M%S).json
  pid=$(launchctl list | awk '$3=="ai.openclaw.gateway"{print $1}')
  builds=$(print -l $CAP/*/captures/**/openclaw-plugin-build-*(N/) | wc -l | tr -d ' ')
  until /opt/homebrew/bin/openclaw gateway call diagnostics.heapProfile --json --params '{"durationMs":900000}' --timeout 960000 > $f.tmp 2>>$OUT/errors.log; do
    # «busy» o gateway che riparte: si riprova senza perdere il giro
    rm -f $f.tmp; sleep 15; quiet_wait; start=$(date +%FT%T)
  done
  mv $f.tmp $f
  fp=$(footprint -p $pid 2>/dev/null | grep -o 'phys_footprint: [0-9.]* [A-Z]*' | grep -o '[0-9.]* [A-Z]*')
  builds2=$(print -l $CAP/*/captures/**/openclaw-plugin-build-*(N/) | wc -l | tr -d ' ')
  ver=$(/opt/homebrew/bin/openclaw --version 2>/dev/null | head -1 | grep -o '[0-9][0-9.]*' | head -1)
  echo "{\"start\":\"$start\",\"ver\":\"$ver\",\"end\":\"$(date +%FT%T)\",\"file\":\"${f:t}\",\"pid\":\"$pid\",\"footprint\":\"$fp\",\"buildsBefore\":$builds,\"buildsAfter\":$builds2}" >> $OUT/windows.jsonl
done
# finito: il plist va in disabled/, così al prossimo login non riparte
mv ~/Library/LaunchAgents/com.jarvis.oc-heapwatch-cont.plist ~/Library/LaunchAgents/disabled/
launchctl bootout gui/$uid/com.jarvis.oc-heapwatch-cont
