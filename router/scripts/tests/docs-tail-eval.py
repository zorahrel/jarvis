#!/usr/bin/env python3
"""Barra del docs-index: una frase presa dall'ultimo terzo di 30 file lunghi (seed fisso)
deve far uscire quel file fra i primi 5. Esce 1 sotto la soglia (--min, default 0.8)."""
import json, os, random, re, sys, urllib.parse, urllib.request, glob
H = os.path.expanduser("~")
files = [f for d in [f"{H}/.claude/jarvis/memory", f"{H}/.openclaw/memory"] for f in glob.glob(d + "/**/*.md", recursive=True)
         if "/archive/" not in f and os.path.getsize(f) > 4000]
files += [f"{H}/.openclaw/MEMORY.md", f"{H}/.openclaw/OPS-ATTILIO.md"]
rnd = random.Random(25)
pick = rnd.sample(sorted(files[:-2]), 28) + files[-2:]
mn = float(sys.argv[sys.argv.index("--min") + 1]) if "--min" in sys.argv else 0.8
hit = 0
for f in pick:
    t = open(f, errors="ignore").read()
    tail = t[len(t) * 2 // 3:]
    sents = [s.strip() for s in re.split(r"[\n.]", tail) if 60 < len(s.strip()) < 220]
    if not sents:
        sents = [tail[:200]]
    q = rnd.choice(sents)
    url = "http://127.0.0.1:3342/search?" + urllib.parse.urlencode({"q": q, "limit": 5})
    res = json.load(urllib.request.urlopen(url, timeout=60))["results"]
    ok = any(r["metadata"]["path"] == f for r in res)
    hit += ok
    print("OK " if ok else "-- ", os.path.relpath(f, H))
rate = hit / len(pick)
print(f"trovati {hit}/{len(pick)} = {rate:.0%}")
sys.exit(0 if rate >= mn else 1)
