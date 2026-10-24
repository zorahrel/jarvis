#!/bin/bash
# Barra del secondo rilevamento di sessioni-limite («aspetta Attilio»): desktop finti in una cartella temporanea,
# transcript finti, stato temporaneo e un hub finto su porta libera che registra le richieste. Mai il vivo.
# Uso: sessioni-limite-test.sh [script]   (con un mutante come argomento: deve andare rosso)
S="${1:-$(dirname "$0")/sessioni-limite}"
exec python3 -I - "$S" <<'PY'
import datetime as dt, json, os, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

SCRIPT = os.path.abspath(sys.argv[1])
RICHIESTE = []


class Hub(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        RICHIESTE.append({"path": self.path, "body": body})
        resp = {"row": {"id": f"att-{len(RICHIESTE)}"}} if body.get("tipo") else {"ok": True}
        data = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


HUB = HTTPServer(("127.0.0.1", 0), Hub)
threading.Thread(target=HUB.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{HUB.server_port}/api/attesa"


def ora_iso(sec_fa):
    return dt.datetime.fromtimestamp(time.time() - sec_fa, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def scena(tmp, righe, quiete_s, archiviata=False):
    """Una sessione desktop: metadati in <account>/<progetto>/local_*.json, transcript in projects/<cartella>/<cli>.jsonl."""
    desk, proj = os.path.join(tmp, "desktop"), os.path.join(tmp, "projects")
    os.makedirs(os.path.join(desk, "acc", "prog"), exist_ok=True)
    os.makedirs(os.path.join(proj, "-Users-x"), exist_ok=True)
    cli = "11111111-2222-3333-4444-555555555555"
    tr = os.path.join(proj, "-Users-x", cli + ".jsonl")
    with open(tr, "w") as f:
        for r in righe:
            f.write(json.dumps(r) + "\n")
    os.utime(tr, (time.time() - quiete_s, time.time() - quiete_s))
    meta = {"sessionId": "local_aaaa", "cliSessionId": cli, "title": "Quadra per commercialisti", "isArchived": archiviata}
    with open(os.path.join(desk, "acc", "prog", "local_aaaa.json"), "w") as f:
        json.dump(meta, f)
    return desk, proj


def tool_uso(id_, nome, sec_fa):
    return {"type": "assistant", "timestamp": ora_iso(sec_fa), "entrypoint": "claude-desktop",
            "message": {"content": [{"type": "text", "text": "Mi serve una scelta."},
                                    {"type": "tool_use", "id": id_, "name": nome, "input": {}}]}}


def tool_esito(id_, sec_fa):
    return {"type": "user", "timestamp": ora_iso(sec_fa), "entrypoint": "claude-desktop",
            "message": {"content": [{"type": "tool_result", "tool_use_id": id_, "content": "ok"}]}}


def testo_fine(sec_fa):
    return {"type": "assistant", "timestamp": ora_iso(sec_fa), "entrypoint": "claude-desktop",
            "message": {"content": [{"type": "text", "text": "Fatto."}]}}


def gira(tmp):
    env = dict(os.environ, SESSIONI_DESKTOP=os.path.join(tmp, "desktop"), SESSIONI_PROJECTS=os.path.join(tmp, "projects"),
               SESSIONI_LIMITE_STATE=os.path.join(tmp, "stato.json"), REGIA_NOTES=os.path.join(tmp, "nessuna-regia"),
               SESSIONI_HUB_URL=URL)
    p = subprocess.run([sys.executable, "-I", SCRIPT], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr


def richieste_attesa():
    return [r for r in RICHIESTE if r["body"].get("tipo") or r["body"].get("kind") == "chiudi"]


def check(nome, ok, dettaglio=""):
    print(f"{'PASS' if ok else 'FAIL'}  {nome}" + ("" if ok else f"  ({dettaglio})"))
    return ok


esiti = []


def titolo_ok(t):
    return t.endswith(": aspetta una tua risposta") and "Quadra per commercialisti" in t


# (a) domanda in sospeso da 25 minuti → una sola voce, tipo decisione
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [testo_fine(3000), tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    rc, out = gira(tmp)
    voci = [r for r in RICHIESTE if r["body"].get("tipo")]
    a_ok = rc == 0 and len(voci) == 1 and voci[0]["body"]["tipo"] == "decisione" and titolo_ok(voci[0]["body"]["title"]) \
        and "ti ha fatto una domanda" in voci[0]["body"]["why"] and voci[0]["body"]["why"].startswith("da ") \
        and voci[0]["body"]["link"] == "claude://claude.ai/epitaxy/local_aaaa" and voci[0]["body"]["from"] == "sessioni-limite"
    esiti.append(check("(a) domanda ferma da 25 min → una voce decisione", a_ok, f"rc={rc} voci={len(voci)} {out.strip()}"))
    # (b) stessa sessione, stessa domanda, secondo giro → nessun duplicato
    prima = len(richieste_attesa())
    gira(tmp)
    esiti.append(check("(b) secondo giro → nessun duplicato", len(richieste_attesa()) == prima, f"richieste {prima} → {len(richieste_attesa())}"))
    # (d) il risultato arriva → una sola chiusura con l'id della voce, e lo stato si svuota
    scena(tmp, [testo_fine(3000), tool_uso("toolu_domanda", "AskUserQuestion", 1500), tool_esito("toolu_domanda", 60)], quiete_s=60)
    prima = len(richieste_attesa())
    gira(tmp)
    nuove = richieste_attesa()[prima:]
    stato = json.load(open(os.path.join(tmp, "stato.json")))
    esiti.append(check("(d) risultato arrivato → una chiusura, stato svuotato",
                       len(nuove) == 1 and nuove[0]["body"] == {"kind": "chiudi", "ref": "att-1"} and not stato.get("attesa"),
                       f"nuove={[r['body'] for r in nuove]} stato={stato.get('attesa')}"))

# (c) permesso in sospeso da 5 minuti → niente, il tool può essere in corso
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [testo_fine(3000), tool_uso("toolu_bash", "Bash", 300)], quiete_s=300)
    gira(tmp)
    esiti.append(check("(c) tool fermo da 5 min → nessuna voce", not richieste_attesa(), f"richieste={[r['body'] for r in RICHIESTE]}"))

# (e) sessione finita: ultima voce testo dell'assistente → niente
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_vecchio", "Read", 3000), tool_esito("toolu_vecchio", 2990), testo_fine(2980)], quiete_s=2980)
    gira(tmp)
    esiti.append(check("(e) sessione finita → nessuna voce", not richieste_attesa(), f"richieste={[r['body'] for r in RICHIESTE]}"))

HUB.shutdown()
ok = all(esiti)
print("PASS tutti i casi" if ok else f"FAIL {esiti.count(False)} caso/i rosso/i")
sys.exit(0 if ok else 1)
PY
