#!/bin/zsh
# Registra con l'ora ogni cartella di build dei plugin che il gateway OpenClaw crea o cancella (23/10, per 6 h e mezza).
# Contare le cartelle presenti non basta: quelle di una generazione ritirata spariscono, il codice caricato no.
CAP=~/.openclaw/tmp/plugin-captures
OUT=~/.cache/oc-heapwatch/cont; mkdir -p $OUT
prev=$OUT/.capwatch.prev; cur=$OUT/.capwatch.cur
# due livelli sotto captures/ (il catalogo modelli annida le sue build): scendere in node_modules costa 3 s a giro
list() { print -l $CAP/*/captures/*(N/) $CAP/*/captures/openclaw-model-catalog-*/*(N/) | sort }
list > $prev
echo "$(date +%FT%T) start $(wc -l < $prev | tr -d ' ')" >> $OUT/captures.log
end=$(( $(date +%s) + 43200 ))
while (( $(date +%s) < end )); do
  sleep 2
  list > $cur
  ts=$(date +%FT%T)
  comm -13 $prev $cur | sed "s|^$CAP/||; s|^|$ts + |" >> $OUT/captures.log
  comm -23 $prev $cur | sed "s|^$CAP/||; s|^|$ts - |" >> $OUT/captures.log
  mv $cur $prev
done
mv ~/Library/LaunchAgents/com.jarvis.oc-capwatch.plist ~/Library/LaunchAgents/disabled/
launchctl bootout gui/$(id -u)/com.jarvis.oc-capwatch
