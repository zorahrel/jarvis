#!/usr/bin/env bash
# Banco di leaky-helpers: ps e footprint finti (un JSON), osascript/open/killall/kill finti che cambiano quel JSON
# come farebbe il Mac e scrivono ogni chiamata in calls.log. Nessun processo vero viene toccato.
#   leaky-helpers-test.sh            la suite
#   LH_SCRIPT=<copia> ...test.sh     la stessa suite su una copia mutata (la usa leaky-helpers-mutants.sh)
set -uo pipefail
SCRIPT="${LH_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/leaky-helpers}"
T=$(mktemp -d "${TMPDIR:-/tmp}/lh-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (atteso '$3', avuto '$2')"; fi; }

mkdir -p "$T/bin"
cat > "$T/bin/fake.py" <<'PY'
#!/usr/bin/env python3
# Finto Mac: smista su argv[0]. osascript quit toglie l'app ma lascia i suoi perl orfani (ppid 1), come il 25/10.
import json, os, sys
S = os.environ["LEAKY_HELPERS_FAKE"]; procs = json.load(open(S))
name, args = os.path.basename(sys.argv[0]), sys.argv[1:]
open(os.environ["LH_CALLS"], "a").write(" ".join([name] + args) + "\n")
APPS = {"Lyric Fever": "/Applications/Lyric Fever.app/Contents/MacOS/Lyric Fever", "Ice": "/Applications/Ice.app/Contents/MacOS/Ice"}
if name == "osascript":
    app = args[1].split('"')[1]
    if app in os.environ.get("LH_DENY", "").split(","):  # TCC nega gli Apple Event, come da launchd senza permesso
        print("36:52: execution error: Not authorized to send Apple events to %s. (-1743)" % app, file=sys.stderr)
        sys.exit(1)
    if app not in os.environ.get("LH_STUCK", "").split(","):
        gone = {p["pid"] for p in procs if p["cmd"] == APPS[app]}
        procs = [p for p in procs if p["pid"] not in gone]
        for p in procs:
            if p["ppid"] in gone: p["ppid"] = 1
elif name == "kill":
    dead = {int(x) for x in args[1:]}
    procs = [p for p in procs if p["pid"] not in dead]
elif name == "killall":
    procs = [p for p in procs if not p["cmd"].endswith("/" + args[0])]
elif name == "open":
    procs.append({"pid": 9000 + len(procs), "ppid": 1, "cmd": APPS[args[1]], "fp_mb": 30})
json.dump(procs, open(S, "w"))
PY
chmod +x "$T/bin/fake.py"
for n in osascript open killall kill; do ln -s "$T/bin/fake.py" "$T/bin/$n"; done

LF=/Applications/Lyric\ Fever.app/Contents/MacOS/Lyric\ Fever
LFPERL='/usr/bin/perl /Applications/Lyric Fever.app/Contents/Resources/MediaRemoteAdapter_MediaRemoteAdapter.bundle/Contents/Resources/run.pl --id com.apple.Music /Applications/Lyric Fever.app/Contents/Frameworks/MediaRemoteAdapter.framework'
WISPR='/usr/bin/perl /Applications/Wispr Flow.app/Contents/Resources/swift-helper-app-dist/Wispr Flow.app/Contents/Resources/MediaRemoteAdapter_MediaRemoteAdapter.bundle/Contents/Resources/run.pl'
WIFI=/System/Library/CoreServices/WiFiAgent.app/Contents/MacOS/WiFiAgent
ICE=/Applications/Ice.app/Contents/MacOS/Ice

# go <idle s> <json dei processi> : un giro, uscita in $RC, chiamate in calls.log
go() {
  printf '%s' "$2" > "$T/ps.json"; : > "$T/calls.log"
  MAC_LIBERO_IDLE=$1 LEAKY_HELPERS_FAKE="$T/ps.json" LEAKY_HELPERS_BIN="$T/bin" LH_CALLS="$T/calls.log" \
    LEAKY_HELPERS_QUIT_WAIT_S=1 "$SCRIPT" > "$T/out.log" 2>&1
  RC=$?
}
calls() { tr '\n' '|' < "$T/calls.log"; }
p() { printf '{"pid":%s,"ppid":%s,"cmd":"%s","fp_mb":%s}' "$1" "$2" "$3" "$4"; }

echo "== Lyric Fever"
go 999 "[$(p 100 1 "$LF" 180),$(p 101 100 "$LFPERL" 301),$(p 200 1 "$WISPR" 900)]"
check "perl a 301 MB: quit, TERM al perl rimasto orfano, riapertura, in quest'ordine" "$(calls)" \
  'osascript -e quit app "Lyric Fever"|kill -TERM 101|open -ga Lyric Fever|'
check "il perl di Wispr Flow (stesso adapter, 900 MB) non si tocca" "$(grep -c ' 200' "$T/calls.log")" 0
grep -q "Lyric Fever: perl MediaRemoteAdapter a 301 MB" "$T/out.log" && ok "una riga nel log con la misura" || bad "manca la riga col perl a 301 MB"
go 999 "[$(p 100 1 "$LF" 180),$(p 101 100 "$LFPERL" 300)]"
check "perl a 300 MB, la soglia: niente" "$(calls)" ""
grep -q "sotto soglia: Lyric Fever 180 MB, perl di Lyric Fever 300 MB" "$T/out.log" && ok "sotto soglia: dice le misure" || bad "manca la riga sotto soglia"
go 999 "[$(p 101 1 "$LFPERL" 1100)]"
check "app chiusa, perl orfano a 1,1 GB: solo il TERM, l'app non si riapre" "$(calls)" 'kill -TERM 101|'
LH_STUCK="Lyric Fever" go 999 "[$(p 100 1 "$LF" 180),$(p 101 100 "$LFPERL" 900)]"
check "l'app non si chiude: exit 1" "$RC" 1
check "  e il perl resta, niente riapertura" "$(calls)" 'osascript -e quit app "Lyric Fever"|'
export LH_STUCK=
LH_DENY="Lyric Fever" go 999 "[$(p 100 1 "$LF" 180),$(p 101 100 "$LFPERL" 900)]"
check "TCC nega il quit: exit 1" "$RC" 1
grep -q 'Lyric Fever: osascript exit 1: .*Not authorized to send Apple events.*(-1743)' "$T/out.log" \
  && ok "  e il log dice il perche' (exit e stderr di osascript)" || bad "manca l'errore di osascript nel log: $(cat "$T/out.log")"

echo "== Mac in uso"
go 10 "[$(p 100 1 "$LF" 180),$(p 101 100 "$LFPERL" 1100),$(p 300 1 "$WIFI" 900),$(p 400 1 "$ICE" 900)]"
check "Attilio fermo da 10 s: nessuna chiamata" "$(calls)" ""
check "  ed exit 0" "$RC" 0

echo "== WiFiAgent e Ice"
go 999 "[$(p 300 1 "$WIFI" 301)]"
check "WiFiAgent a 301 MB: killall" "$(calls)" 'killall WiFiAgent|'
go 999 "[$(p 300 1 "$WIFI" 300),$(p 400 1 "$ICE" 400)]"
check "WiFiAgent a 300 e Ice a 400: niente" "$(calls)" ""
go 999 "[$(p 400 1 "$ICE" 401)]"
check "Ice a 401 MB: quit e riapertura" "$(calls)" 'osascript -e quit app "Ice"|open -ga Ice|'

echo "== misura vera (proc_pid_rusage): uguale a footprint -p, entro il 25%"
python3 -c 'b = b"x" * (60 << 20); import time; time.sleep(30)' & hold=$!
sleep 1
mine=$(python3 -I - "$SCRIPT" "$hold" <<'PY'
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("lh", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("lh", loader)); loader.exec_module(m)
print(m.footprint_mb(int(sys.argv[2])))
PY
)
ref=$(footprint -p "$hold" --noCategories 2>/dev/null | awk '/phys_footprint:/ {u=$3; print int(u=="GB" ? $2*1024 : u=="KB" ? $2/1024 : $2); exit}')
kill "$hold" 2>/dev/null; wait "$hold" 2>/dev/null
if [ -n "$ref" ] && [ "${mine:-0}" -ge $((ref * 3 / 4)) ] && [ "${mine:-0}" -le $((ref * 5 / 4)) ]; then
  ok "processo da ~60 MB: $mine MB, footprint -p $ref MB"
else bad "footprint_mb $mine MB contro footprint -p ${ref:-?} MB"; fi

echo "== misura vera dove RSS e footprint divergono: 200 MB di file mappati e toccati (residenti, ma non nel footprint)"
# su memoria anonima i due numeri coincidono e un footprint_mb che legge resident_size resterebbe verde
head -c $((200 << 20)) /dev/zero > "$T/mapped.bin"
python3 -c '
import mmap, sys, time
f = open(sys.argv[1], "rb"); m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
s = sum(m[i] for i in range(0, len(m), 16384))
print("pronto", flush=True); time.sleep(40)' "$T/mapped.bin" > "$T/mapped.out" & hold=$!
for _ in $(seq 50); do [ -s "$T/mapped.out" ] && break; sleep 0.2; done
sleep 0.5
rss=$(( $(ps -o rss= -p "$hold" 2>/dev/null | tr -d " " | sed "s/^$/0/") / 1024 ))
ref=$(footprint -p "$hold" --noCategories 2>/dev/null | awk '/phys_footprint:/ {u=$3; print int(u=="GB" ? $2*1024 : u=="KB" ? $2/1024 : $2); exit}')
mine=$(python3 -I - "$SCRIPT" "$hold" <<'PY'
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("lh", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("lh", loader)); loader.exec_module(m)
print(m.footprint_mb(int(sys.argv[2])))
PY
)
kill "$hold" 2>/dev/null; wait "$hold" 2>/dev/null
if [ "$rss" -ge 150 ] && [ "${ref:-999}" -le 50 ]; then ok "il caso diverge davvero: RSS $rss MB, footprint -p ${ref} MB"
else bad "caso non divergente (RSS $rss MB, footprint -p ${ref:-?} MB): il banco non prova niente"; fi
if [ -n "$mine" ] && [ "$mine" -le $((${ref:-0} + 15)) ]; then ok "footprint_mb legge il footprint, non il residente ($mine MB)"
else bad "footprint_mb $mine MB: il residente e' $rss MB, il footprint vero ${ref:-?} MB"; fi

echo "== banco"
printf '[]' > "$T/ps.json"
MAC_LIBERO_IDLE=999 LEAKY_HELPERS_FAKE="$T/ps.json" "$SCRIPT" > "$T/out.log" 2>&1
check "processi finti senza comandi finti: rifiuta (un kill vero su pid finti)" "$?" 2

echo; echo "$PASS ok, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
