---
name: pulse
description: Comando pulse (migrato da Claude Code slash command).
---

Sei il Pulse Scanner di Jarvis. Quando invocato, fai un check completo di tutte le sessioni Claude Code attive sulla macchina e proponi azioni rapide.

## Step 1: Scan

Esegui questo script Python:

```bash
python3 << 'PULSE_EOF'
import json, os, glob
from datetime import datetime, timezone

SESSIONS_DIR = os.path.expanduser("~/.claude/sessions")
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
STATE_DIR = os.path.expanduser("~/.claude/jarvis/memory/pulse")
STATE_FILE = os.path.join(STATE_DIR, "state.json")

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f: return json.load(f)
    return {"sessions": {}, "last_scan": None, "scan_count": 0}

def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_FILE, "w") as f: json.dump(state, f, indent=2)

def is_alive(pid):
    try: return bool(os.popen(f"ps -p {pid} -o comm= 2>/dev/null").read().strip())
    except: return False

def find_jsonl(session_id):
    for pd in os.listdir(PROJECTS_DIR):
        c = os.path.join(PROJECTS_DIR, pd, f"{session_id}.jsonl")
        if os.path.exists(c): return c
    return None

def extract_text(content):
    if isinstance(content, str): return content
    if isinstance(content, dict):
        c = content.get("content", "")
        if isinstance(c, list):
            t = [b.get("text","") for b in c if isinstance(b, dict) and b.get("type") == "text"]
            return " ".join(t) if t else None
        elif isinstance(c, str): return c
    return None

def extract_last_messages(jsonl_path):
    if not jsonl_path or not os.path.exists(jsonl_path): return None, None, None, 0
    with open(jsonl_path) as f: lines = f.readlines()
    total = len(lines)
    lh = lht = la = lat = None
    for line in reversed(lines[-200:]):
        try: msg = json.loads(line.strip())
        except: continue
        role = msg.get("role", msg.get("type", ""))
        ts = msg.get("timestamp")
        if role == "user" and not lh:
            text = extract_text(msg.get("message", msg.get("content", "")))
            if text and text.strip(): lh, lht = text.strip()[:200], ts
        elif role == "assistant" and not la:
            text = extract_text(msg.get("message", msg.get("content", "")))
            if text and text.strip(): la, lat = text.strip()[:300], ts
        if lh and la: break
    return lh, la, lat or lht, total

def idle_minutes(last_ts):
    if not last_ts: return None
    try:
        dt = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
        return int((datetime.now(timezone.utc) - dt).total_seconds() / 60)
    except: return None

def fmt_idle(mins):
    if mins is None: return "?"
    if mins < 60: return f"{mins}m"
    if mins < 1440: return f"{mins//60}h{mins%60}m"
    return f"{mins//1440}d{(mins%1440)//60}h"

def classify(alive, idle_min):
    if not alive: return "dead"
    if idle_min is None: return "unknown"
    if idle_min < 5: return "active"
    if idle_min < 30: return "idle"
    if idle_min < 120: return "stale"
    return "dormant"

state = load_state()
prev = state.get("sessions", {})
current = {}
new_sessions = []

for sf in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
    try:
        with open(sf) as f: sess = json.load(f)
    except: continue
    pid = sess.get("pid"); sid = sess.get("sessionId", ""); cwd = sess.get("cwd", "?")
    project = os.path.basename(cwd)
    alive = is_alive(pid)
    jsonl = find_jsonl(sid)
    last_h, last_a, last_ts, total = extract_last_messages(jsonl)
    idle = idle_minutes(last_ts)
    status = classify(alive, idle)
    entry = {
        "pid": pid, "sid": sid[:8], "project": project, "cwd": cwd,
        "kind": sess.get("kind","?"), "entrypoint": sess.get("entrypoint","?"),
        "alive": alive, "status": status, "idle_min": idle, "idle_fmt": fmt_idle(idle),
        "messages": total, "last_human": last_h, "last_assistant": last_a,
        "last_activity": last_ts,
    }
    current[str(pid)] = entry
    if str(pid) not in prev: new_sessions.append(entry)

disappeared = [prev[p] for p in prev if p not in current]

state["sessions"] = current
state["last_scan"] = datetime.now(timezone.utc).isoformat()
state["scan_count"] = state.get("scan_count", 0) + 1
save_state(state)

by_status = {}
for e in current.values(): by_status.setdefault(e["status"], []).append(e)

out = {
    "scan_time": state["last_scan"], "scan_number": state["scan_count"],
    "total": len(current),
    "counts": {k: len(v) for k, v in by_status.items()},
    "sessions": sorted(current.values(), key=lambda x: x.get("idle_min") or 9999),
    "new": new_sessions, "disappeared": disappeared,
}
print(json.dumps(out, indent=2, ensure_ascii=False))
PULSE_EOF
```

## Step 2: Presenta il report

Dopo lo scan, presenta i risultati in una singola tabella con azione suggerita inline per ogni sessione.

### Header
```
PULSE #N -- YYYY-MM-DD HH:MM
N sessioni | N active | N idle | N stale | N dormant | N dead
```

### Tabella unica con azione inline

Ogni riga ha: status icon, progetto, idle time, cosa faceva, e AZIONE SUGGERITA.

| St | Progetto (PID) | Idle | Cosa faceva | Azione |
|---|---|---|---|---|
| `[*]` | jarvis (4179) | 0m | (tu) | -- |
| `[*]` | topics-app (98778) | 2m | Focus refactor, attende commit | -- |
| `[~]` | armonia-site (46025) | 17m | Responsiveness pushata | **CHIUDI** task finito |
| `[z]` | topics-app (89001) | 1d6h | /open-project, completato | **CHIUDI** task finito |
| `[?]` | jarvis (45725) | ? | Zombie, 0 msg | **KILL** zombie |

Le azioni possibili nella colonna Azione:
- **CHIUDI** -- sessione che ha completato il task, da terminare
- **KILL** -- processo zombie/dead/senza conversazione
- **HARVEST** -- sessione con context utile da salvare prima di chiudere
- **RESUME** -- sessione idle con task incompleto, vale la pena riprenderla
- `--` -- sessione attiva, non toccare

Identifica la sessione corrente (confronta PID o cwd) e marcala `(tu)`, azione `--`.

### Recap azioni numerate

Sotto la tabella, raggruppa le azioni in numeri per esecuzione rapida:

```
1. CHIUDI completate: PID 46025, 62799, 89001, 93029
2. KILL zombie: PID 45725
3. HARVEST + CHIUDI: PID 88505 (ha context utile)
```

**Numeri?**

## Step 3: Esegui azioni scelte

Quando l'utente risponde con numeri (es. "1 3" o "1,2,3" o "tutti"):

- **CHIUDI/KILL**: `kill <pid>`, verifica con `ps` che sia morto. Se non muore con SIGTERM, aspetta 2s e usa SIGKILL. Poi rimuovi `~/.claude/sessions/<pid>.json`.
- **HARVEST**: leggi ultimi 100 messaggi del JSONL, estrai summary 2-3 righe per sessione, salva in append su `~/.claude/jarvis/memory/pulse/harvest-YYYY-MM-DD.md` con timestamp e progetto. Poi chiudi la sessione.
- **RESUME**: indica quale tab aprire e cosa dire per riprendere.

Dopo aver eseguito, mostra riepilogo breve.

## Regole

- Lingua: italiano
- Conciso, zero filler
- Mai killare la sessione corrente
- Proponi SEMPRE almeno un'azione -- se tutto e' pulito, dillo in una riga
- kill SIGTERM e' gentile, il processo si chiude pulito e la tab si chiude con esso
- State persiste tra invocazioni -- al prossimo /pulse mostra il delta
- Se l'utente passa argomenti (es. `/pulse harvest`, `/pulse kill dormant`), esegui direttamente senza chiedere
