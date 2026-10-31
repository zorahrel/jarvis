#!/usr/bin/env python3
"""Props per il widget session:report: diagramma dei passi + stato dell'ultimo giro + resume token.
Fonti: i .lobster qui accanto, runs.jsonl (scritto da runlog.py) e i checkpoint vivi in ~/.lobster/state."""
import base64, glob, json, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.expanduser(os.environ.get("LOBSTER_STATE_DIR", "~/.lobster/state"))
CMD = re.compile(r"runlog\.py\s+(\S+)\s+(\S+)")

def steps_of(path):
    out, cur = [], None
    for l in open(path):
        m = re.match(r"\s*- id:\s*(\S+)", l)
        if m: cur = {"id": m[1], "gate": False}; out.append(cur)
        elif cur and re.match(r"\s*approval:\s*required", l): cur["gate"] = True
    return out

def token(key):
    return base64.urlsafe_b64encode(json.dumps({"protocolVersion": 1, "v": 1, "kind": "workflow-file", "stateKey": key}, separators=(",", ":")).encode()).decode().rstrip("=")

pending = {}
for f in sorted(glob.glob(os.path.join(STATE, "workflow_resume_*.json")), key=os.path.getmtime):
    d = json.load(open(f))
    pending[os.path.basename(d["filePath"])[:-8]] = (d, os.path.basename(f)[:-5])

events = {}
rl = os.path.join(HERE, "runs.jsonl")
if os.path.exists(rl):
    for l in open(rl):
        e = json.loads(l); events.setdefault(e["workflow"], []).append(e)

rows, blocks, hist = [], [], []
for p in sorted(glob.glob(os.path.join(HERE, "*.lobster"))):
    wf = os.path.basename(p)[:-8]; st = steps_of(p); ev = events.get(wf, [])
    last = ev[-1]["run"] if ev else None
    mine = [e for e in ev if e["run"] == last]
    ok = {e["step"] for e in mine if e["status"] in ("step-ok", "done")}
    failed = [e["step"] for e in mine if e["status"] == "failed"]
    running = mine and mine[-1]["status"] == "running"
    gate = pending.get(wf)
    # il cancello vivo vale solo se appartiene all'ultimo giro (stato più recente dell'ultimo evento)
    if failed: status, tok = "FALLITO su " + failed[-1], "-"
    elif gate and (not mine or os.path.getmtime(os.path.join(STATE, gate[1] + ".json")) >= max(os.path.getmtime(rl), 0) - 600 and gate[0]["steps"].keys() >= ok):
        status, tok = f"FERMO su approvazione ({gate[0]['approvalStepId']})", token(gate[1])
        ok |= set(gate[0]["steps"].keys())
    elif running: status, tok = "IN CORSO", "-"
    elif mine and mine[-1]["status"] == "done": status, tok = "FATTO", "-"; ok = {s["id"] for s in st}
    else: status, tok = "mai lanciata", "-"
    if mine: ok |= {s["id"] for s in st if s["id"] in ok}
    def mark(s):
        return ("✔ " if s["id"] in ok else "✘ " if s["id"] in failed else "▶ " if running and s["id"] == mine[-1]["step"] else "○ ") + s["id"] + (" 🔒" if s["gate"] else "")
    when = mine[-1]["ts"][:16].replace("T", " ") if mine else "-"
    rows.append([wf, status, f"{len(ok & {s['id'] for s in st})}/{len(st)}", when, tok[:16] + ("…" if len(tok) > 16 else "")])
    blocks.append({"type": "text", "title": f"{wf} · {status}", "text": " → ".join(mark(s) for s in st) + ("\nresume token: " + tok if tok != "-" else "")})
    runs_seen = []
    for e in ev:
        if e["run"] not in runs_seen: runs_seen.append(e["run"])
    for r in runs_seen[-3:]:
        last_e = [e for e in ev if e["run"] == r][-1]
        hist.append([wf, r, last_e["ts"][:16].replace("T", " "), {"done": "fatto", "failed": "fallito", "running": "in corso/fermo", "step-ok": "in corso/fermo"}[last_e["status"]]])

props = {"blocks": [{"type": "table", "title": "Pipeline Lobster · ultimo giro", "columns": ["pipeline", "stato", "passi", "ultimo evento", "resume token"], "rows": rows}] + blocks[:10] +
         [{"type": "table", "title": "Ultimi giri", "columns": ["pipeline", "giro", "quando", "esito"], "rows": hist[-12:]}]}
print(json.dumps(props, ensure_ascii=False))
