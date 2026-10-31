#!/bin/bash
# Barra di memlog (exit 0 = verde): parse su testo vero, gruppi, rotazione a 14 righe, soglie di --check
# con una mutazione sul punto critico (9 pagine/s sotto la soglia, 10 sopra).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MEMLOG_FILE="$TMP/memlog.log" MEMLOG_MAX_LINES=14 MEMLOG_TOPICS_LOG="$TMP/none.log" \
  /usr/bin/python3 -I - "$DIR/memlog" "$TMP" <<'PY'
import importlib.machinery, importlib.util, json, sys, time, datetime as dt
src, tmp = sys.argv[1], sys.argv[2]
loader = importlib.machinery.SourceFileLoader("memlog", src)
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("memlog", loader)); loader.exec_module(m)

VM = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                6686.
Pages speculative:                         4571.
Pages wired down:                        483347.
Pages purgeable:                           6367.
File-backed pages:                       432840.
Pages occupied by compressor:            349662.
Swapins:                              398367481.
"""
v = m.parse_vm_stat(VM)
assert v["wired_mb"] == 7552 and v["comp_mb"] == 5463 and v["swapins"] == 398367481, v
assert v["avail_gb"] == 7.4, v            # (6686+4571+6367+432840) * 16384 / 1e9
assert m.parse_swap("vm.swapusage: total = 7168.00M  used = 5971.06M  free = 1196.94M  (encrypted)") == (5971, 7168)
assert m.mem_mb("2254M") == 2254 and m.mem_mb("13G") == 13312 and m.mem_mb("26K+") == 26 / 1024 and m.mem_mb("x") is None
rows = m.parse_top("PID MEM COMMAND\n67985 2254M node\n69368 1469M+ Claude Helper (R\n")
assert rows == {67985: (2254, "node"), 69368: (1469, "Claude Helper (R")}, rows

G = {
 "/opt/homebrew/opt/node/bin/node --max-old-space-size=8192 /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway": "OpenClaw",
 "openclaw-node-worker": "OpenClaw",
 "/Users/z/Library/Application Support/Claude/claude-code/2.1.308/a9/claude.app/Contents/MacOS/claude --output-format": "claude-cli",
 "/Library/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python -u /Users/z/.claude/jarvis/router/scripts/docs-server.py": "Python:docs-server.py",
 "/opt/homebrew/Cellar/node/26/bin/node /Users/z/p/node_modules/typescript/lib/tsserver.js --serverMode": "node:tsserver.js",
 "/Applications/Helium.app/Contents/Frameworks/Helium Framework.framework/Versions/1/Helpers/Helium Helper (Renderer).app/Contents/MacOS/Helium Helper (Renderer) --type=renderer": "Helium",
 "/Applications/Claude.app/Contents/MacOS/Claude": "Claude",
 "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent": "WebKit",
 "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon": "WindowServer",
 # mailwatch.py sta sotto ~/.openclaw/bin: «.openclaw/» non e' «/openclaw/», e' un piccolo script e non il gateway
 "/usr/bin/python3 /Users/z/.openclaw/bin/mailwatch.py": "python3:mailwatch.py",
}
for cmd, want in G.items():
    assert m.group(cmd) == want, (cmd, m.group(cmd), want)
tot, top = m.top_groups({1: (3000, "a"), 2: (500, "b"), 3: (700, "c")}, {1: "/Applications/A.app/x", 2: "/Applications/B.app/x", 3: "/Applications/A.app/y"}, n=1)
assert (tot, top) == (4200, "A:3.6"), (tot, top)

now = time.time()
def memsig(age, held=7.0):
    t = dt.datetime.fromtimestamp(now - age, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return f"{t} [memsig] avail=7.5 held2m={held} cover=170s swap=calm\n"
assert m.parse_memsig("rumore\n" + memsig(60) + "altro\n", now) == (7.0, "calm")
assert m.parse_memsig(memsig(600), now) == (None, None), "memsig vecchia di 10 min: Topics cieco, non 7,0"
assert m.parse_memsig("nessuna riga\n", now) == (None, None)

# rotazione: tetto 14 + 1 di margine, 20 scritture -> restano le ultime 14
p = tmp + "/memlog.log"
for i in range(20):
    m.append({"t": dt.datetime.fromtimestamp(now - (20 - i) * 300).isoformat(timespec="seconds"), "i": i}, p)
kept = [json.loads(l)["i"] for l in open(p)]
assert kept == list(range(6, 20)), kept
assert m.trim(list(range(15))) == list(range(15)), "sotto keep+slack non si riscrive"

# check: pressione cronica, calma, fermo
def series(rate, swap=6300, n=30, age=0):
    base = 398_000_000
    return [{"t": dt.datetime.fromtimestamp(now - age - (n - 1 - i) * 300).isoformat(timespec="seconds"),
             "swap_mb": swap, "swap_tot_mb": 7168, "swapins": base + int(rate * 300 * i),
             "lvl": 52, "topics_gb": 7.0, "top": "OpenClaw:3.4,Claude:3.2,Helium:2.2"} for i in range(n)]
def put(rows):
    open(p, "w").write("".join(json.dumps(r) + "\n" for r in rows))
put(series(10)); out = m.check(p, now)
assert len(out) == 1 and "pressione da 2 h" in out[0] and "OpenClaw 3.4" in out[0], out
put(series(9)); assert m.check(p, now) == [], "9 pagine/s e' sotto la soglia di Topics"
put(series(50, swap=5000)); assert m.check(p, now) == [], "swap al 70%: non e' pressione"
put(series(10, age=3600)); out = m.check(p, now)
assert len(out) == 1 and "registro fermo" in out[0], out
open(p, "w").write(""); assert "mai" in m.check(p, now)[0]
put(series(10)); rep = m.report(7, p, now)
assert rep["samples"] == 30 and rep["expected"] == 30 and rep["swap_hi_share"] == 1.0 and rep["top"][0] == ("OpenClaw", 3.4), rep
print("memlog-test: tutto verde")
PY
