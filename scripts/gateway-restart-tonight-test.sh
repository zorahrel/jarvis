#!/bin/bash
# Barra di gateway-restart-tonight: HOME finta, launchctl/date/curl finti (GRT_STUBS), mac-libero e board-card
# finti. Il «gateway» che il kickstart finto avvia è il codice vero di ~/Projects/mcp-hot-gateway, su una porta
# libera e con la config finta: la riga «idle park» che lo script legge la scrive lui. Mai il gateway vivo.
# Uso: gateway-restart-tonight-test.sh [script]   (con un mutante come argomento: deve andare rosso)
set -u
S="${1:-$(dirname "$0")/gateway-restart-tonight}"
S="$(cd "$(dirname "$S")" && pwd)/$(basename "$S")"
GW_INDEX="$HOME/Projects/mcp-hot-gateway/index.mjs"
T=$(mktemp -d "${TMPDIR:-/tmp}/grt-test.XXXXXX")
fail=0
ok() { if [ "$1" = 0 ]; then echo "  ✓ $2"; else echo "  ✗ $2${3:+ — $3}"; fail=1; fi; }
cleanup() { [ -f "$T/gw.pid" ] && kill "$(cat "$T/gw.pid")" 2>/dev/null; trash "$T" 2>/dev/null; }
trap cleanup EXIT

# Uno script senza GRT_STUBS userebbe il launchctl vero: sul giro del riavvio riavvierebbe il gateway vivo.
seam=0; /usr/bin/grep -q 'GRT_STUBS' "$S" && seam=1
h=$(date +%H)
if [ $seam = 0 ]; then
  case "$h" in 01|02|03|04|05) echo "rifiuto: $S non ha GRT_STUBS e alle $h entrerebbe nel giro vero"; exit 2 ;; esac
fi

home() {  # una HOME finta pulita in $T/$1
  local F="$T/$1"
  mkdir -p "$F/bin" "$F/.claude/jarvis/scripts" "$F/.claude/jarvis/logs" "$F/.claude/jarvis/state" \
           "$F/.claude/jarvis/tools/usage-hub/src" "$F/.claude/jarvis/mcp-servers/gateway" "$F/Library/LaunchAgents" "$F/stubs"
  printf '#!/bin/sh\nexit 0\n' > "$F/bin/mac-libero"
  printf '#!/bin/sh\necho "$@" >> "%s/board-card.calls"\n' "$F" > "$F/.claude/jarvis/scripts/board-card"
  # Nessuna chiamata in corso.
  echo 'export async function callGateway() { return JSON.stringify({ children: [{ name: "x", stats: { inFlight: 0 } }] }); }' \
    > "$F/.claude/jarvis/tools/usage-hub/src/mcpgw.mjs"
  # Config come la lascia il gateway vecchio: idleParkMinutes di chrome-devtools perso alla riscrittura.
  printf '{\n  "children": [\n    {\n      "name": "chrome-devtools",\n      "transport": "stdio",\n      "command": "/usr/bin/false",\n      "autoMount": false\n    }\n  ]\n}\n' \
    > "$F/.claude/jarvis/mcp-servers/gateway/gateway-config.json"
  echo "[mcp-gateway] righe di prima" > "$F/.claude/jarvis/logs/gateway.err.log"
  echo '<plist/>' > "$F/Library/LaunchAgents/com.jarvis.gateway-restart-tonight.plist"
  printf '#!/bin/sh\ncase "$1" in +%%H) echo "$FAKE_HOUR" ;; *) exec /bin/date "$@" ;; esac\n' > "$F/stubs/date"
  printf '#!/bin/sh\nprintf 404\n' > "$F/stubs/curl"
  cat > "$F/stubs/launchctl" <<EOF
#!/bin/bash
case "\$1" in
  list) [ -f "$T/gw.pid" ] && printf '%s\t0\tcom.jarvis.gateway\n' "\$(cat "$T/gw.pid")" ;;
  kickstart)
    [ -f "$T/gw.pid" ] && kill "\$(cat "$T/gw.pid")" 2>/dev/null
    MCP_GATEWAY_CONFIG="$F/.claude/jarvis/mcp-servers/gateway/gateway-config.json" GATEWAY_HTTP_PORT=\$((24100 + RANDOM % 800)) \
      nohup node "$GW_INDEX" >/dev/null 2>>"$F/.claude/jarvis/logs/gateway.err.log" &
    echo \$! > "$T/gw.pid" ;;
  bootout) echo bootout >> "$F/launchctl.calls" ;;
esac
EOF
  chmod +x "$F/bin/mac-libero" "$F/.claude/jarvis/scripts/board-card" "$F/stubs/"*
  echo "$F"
}
# Lancia lo script con un tetto di secondi; stampa l'exit code (124 = tetto superato).
run() {
  local F=$1 hour=$2 cap=$3
  HOME="$F" FAKE_HOUR=$hour GRT_STUBS="$F/stubs" /bin/bash "$S" >/dev/null 2>"$F/err" &
  local p=$! start=$SECONDS
  while kill -0 $p 2>/dev/null && [ $((SECONDS - start)) -lt "$cap" ]; do sleep 0.2; done
  if kill -0 $p 2>/dev/null; then kill $p; wait $p 2>/dev/null; echo 124; else wait $p; echo $?; fi
}

echo; echo "notti saltate"
F=$(home skip)
for n in 1 2 3; do
  rc=$(run "$F" 15 20)
  calls=$(cat "$F/board-card.calls" 2>/dev/null | wc -l | tr -d ' ')
  if [ $n -lt 3 ]; then ok $([ "$rc" = 0 ] && [ "$calls" = 0 ]; echo $?) "notte $n fuori finestra: esce 0, nessuna card" "rc=$rc card=$calls"; fi
done
ok $([ "$(cat "$F/.claude/jarvis/state/gateway-restart-tonight.skips" 2>/dev/null)" = 3 ]; echo $?) "le notti saltate si contano" "file=$(cat "$F/.claude/jarvis/state/gateway-restart-tonight.skips" 2>/dev/null)"
ok $([ "$calls" = 1 ] && /usr/bin/grep -q -- '--key gateway-restart-tonight-ko' "$F/board-card.calls"; echo $?) "alla terza notte si apre la card gateway-restart-tonight-ko" "chiamate=$calls"
ok $(/usr/bin/grep -q 'notti saltate di fila: 3' "$F/.claude/jarvis/logs/gateway-restart-tonight.log" 2>/dev/null; echo $?) "il log dice quante notti"
ok $([ -f "$F/Library/LaunchAgents/com.jarvis.gateway-restart-tonight.plist" ]; echo $?) "una notte saltata non disattiva il job"

echo; echo "giro del riavvio"
if [ $seam = 0 ]; then
  ok 1 "lo script si fa provare il giro del riavvio" "manca GRT_STUBS: con il launchctl vero riavvierebbe il gateway vivo"
else
  F=$(home restart)
  echo 2 > "$F/.claude/jarvis/state/gateway-restart-tonight.skips"
  start=$SECONDS; rc=$(run "$F" 03 60); took=$((SECONDS - start))
  ok $([ "$rc" = 0 ] && [ $took -lt 30 ]; echo $?) "riavvia e verifica senza aspettare minuti a vuoto" "rc=$rc in ${took}s"
  ok $(/usr/bin/grep -q '^.* OK: ' "$F/.claude/jarvis/logs/gateway-restart-tonight.log" 2>/dev/null; echo $?) "esito OK nel log" \
    "$(tail -1 "$F/.claude/jarvis/logs/gateway-restart-tonight.log" 2>/dev/null)"
  ok $(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(j.children[0].idleParkMinutes===60?0:1)' \
    "$F/.claude/jarvis/mcp-servers/gateway/gateway-config.json"; echo $?) "idleParkMinutes 60 di chrome-devtools rimesso prima del riavvio"
  ok $(/usr/bin/grep -q 'chrome-devtools=60 min' "$F/.claude/jarvis/logs/gateway.err.log"; echo $?) "il gateway nuovo lo legge: chrome-devtools a riposo dopo 60 min"
  ok $([ "$(cat "$F/.claude/jarvis/state/gateway-restart-tonight.skips")" = 0 ]; echo $?) "riavvio fatto: le notti saltate si azzerano"
  ok $([ ! -f "$F/board-card.calls" ]; echo $?) "nessuna card se va bene"
  ok $([ -f "$F/Library/LaunchAgents/disabled/com.jarvis.gateway-restart-tonight.plist" ]; echo $?) "il job si toglie da solo"
fi

[ $fail = 0 ] && echo && echo "all green" && exit 0
echo; echo "rosso"; exit 1
