#!/usr/bin/env bash
# Barra di offload: gira sul PC vero (deve essere acceso o svegliabile). exit 0 = tutto verde.
set -u
T=$(mktemp -d)
# la copia sul PC ha lo stesso nome che le dà offload: si toglie a fine giro
N="$(basename "$T" | tr -c 'A-Za-z0-9_-' '_')_$(printf %s "$T" | shasum | cut -c1-6)"
trap 'rm -rf "$T"; ssh -o BatchMode=yes -o ConnectTimeout=5 "${OFFLOAD_HOST:-zorah@192.168.1.2}" "rmdir /s /q E:\\offload\\$N" >/dev/null 2>&1' EXIT
cd "$T" && git init -q && echo 'SECRET=boom' > .env
echo 'const fs=require("fs");fs.mkdirSync("out",{recursive:true});fs.writeFileSync("out/r.txt","os="+process.platform+" env="+fs.existsSync(".env"));process.exit(Number(process.argv[2]||0))' > job.js
git add job.js
F=0; ok() { echo "ok   $1"; }; ko() { echo "FAIL $1"; F=1; }
offload --pc --get out -- node job.js 0 2>/dev/null; [ $? = 0 ] && ok "giro sul PC, exit 0" || ko "giro sul PC"
r=$(cat out/r.txt 2>/dev/null); [ "${r%% *}" = os=win32 ] && ok "ha girato su Windows" || ko "piattaforma: $r"
[ "${r##* }" = env=false ] && ok ".env rimasto sul Mac" || ko "il segreto è arrivato sul PC: $r"
offload --pc -- node job.js 3 >/dev/null 2>&1; [ $? = 3 ] && ok "exit code del PC riportato" || ko "exit code perso"
o=$(OFFLOAD_MAX_MAC=999 offload --mac-cmd "echo mac" -- "echo pc" 2>/dev/null); [ "$o" = mac ] && ok "Mac libero: resta qui" || ko "Mac libero ma: $o"
o=$(OFFLOAD_MAX_MAC=0 offload --mac-cmd "echo mac" -- "echo pc" 2>/dev/null | tr -d '\r '); [ "$o" = pc ] && ok "Mac carico: va sul PC" || ko "Mac carico ma: $o"
o=$(OFFLOAD_MAX_MAC=0 OFFLOAD_HOST=zorah@192.0.2.1 offload --mac-cmd "echo mac" -- "echo pc" 2>/dev/null | tail -1); [ "$o" = mac ] && ok "PC irraggiungibile: resta qui" || ko "PC irraggiungibile ma: $o"
exit $F
