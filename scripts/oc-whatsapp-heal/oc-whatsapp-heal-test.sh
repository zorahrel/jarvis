#!/bin/sh
# Barra di oc-whatsapp-heal: log finti con le righe vere del 14/10 spostate a "adesso".
# HEAL=<percorso> prova un'altra copia dello script (per la mutazione).
HEAL=${HEAL:-$(dirname "$0")/oc-whatsapp-heal}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ok=0; ko=0
OWNS='{"0":"{\"subsystem\":\"channels/whatsapp\"}","1":"[default] channel exited: Another process owns this WhatsApp connection.","time":"TS+02:00"}'
UP='{"0":"{\"subsystem\":\"channels/whatsapp\"}","1":"Listening for WhatsApp inbound messages (DM + 7 configured groups).","time":"TS+02:00"}'
ts() { date -r $(( $(date +%s) - $1 * 60 )) +%Y-%m-%dT%H:%M:%S; }
line() { case $1 in owns) echo "$OWNS";; up) echo "$UP";; esac | sed "s/TS/$(ts $2)/"; }
scenario() {  # nome, gateway, atteso (si/no), poi coppie tipo:minuti-fa
  name=$1 gw=$2 want=$3; shift 3
  rm -rf "$T/logs" "$T/called"; mkdir -p "$T/logs"
  for e in "$@"; do line "${e%%:*}" "${e##*:}" >> "$T/logs/openclaw-test.log"; done
  printf '#!/bin/sh\ntouch %s/called\n' "$T" > "$T/restart"; chmod +x "$T/restart"
  OC_LOGDIR=$T/logs OC_RESTART=$T/restart OC_HEAL_STATE=$T/state.json OC_GATEWAYS=$gw "$HEAL" >/dev/null 2>&1
  got=no; [ -f "$T/called" ] && got=si
  if [ "$got" = "$want" ]; then ok=$((ok+1)); echo "  ok   $name"; else ko=$((ko+1)); echo "  FAIL $name (riavvio: atteso $want, avuto $got)"; fi
}
rm -f "$T/state.json"
scenario "3 errori dopo l'ultimo ascolto: riavvia" 1 si up:25 owns:12 owns:8 owns:3
rm -f "$T/state.json"
scenario "2 errori soli: aspetta" 1 no up:25 owns:6 owns:3
scenario "errori poi di nuovo in ascolto: niente" 1 no owns:15 owns:12 owns:9 up:2
scenario "errori fuori dalla finestra di 30 min: niente" 1 no owns:50 owns:45 owns:40
scenario "due gateway vivi: conflitto vero, niente" 2 no owns:9 owns:6 owns:3
scenario "nessun evento: niente" 1 no
echo "{\"healed_at\": $(( $(date +%s) - 300 ))}" > "$T/state.json"
scenario "3 errori ma riavviato 5 min fa: cooldown" 1 no owns:9 owns:6 owns:3
echo "$ok ok, $ko FAIL"; [ $ko -eq 0 ]
