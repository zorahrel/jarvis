#!/bin/bash
# Barra di sessioni-limite: desktop finti in una cartella temporanea, transcript finti, stato e diario temporanei, e un
# hub finto su porta libera. Ogni POST passa dal validatore vero (usage-hub/src/attesa.mjs): se rifiuta, 400. Mai il vivo.
# Uso: sessioni-limite-test.sh [script]   (con un mutante come argomento: deve andare rosso)
S="${1:-$(dirname "$0")/sessioni-limite}"
exec python3 -I - "$S" <<'PY'
import datetime as dt, json, os, pathlib, re, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

SCRIPT = os.path.abspath(sys.argv[1])
VALIDATORE = os.path.expanduser("~/.claude/jarvis/tools/usage-hub/src/attesa.mjs")
VALIDA_JS = "import fs from 'node:fs'; const { validateAttesa } = await import(process.argv[1]);" \
            " process.stdout.write(validateAttesa(JSON.parse(fs.readFileSync(0, 'utf8'))) || '');"
CLI = "11111111-2222-3333-4444-555555555555"
RICHIESTE = []
RIFIUTA = {"on": False}  # hub giù: ogni POST risponde 503 (serve al caso del diario)


def validatore(raw):
    """L'errore che il validatore vero dà a questo corpo, o None se passa."""
    p = subprocess.run(["node", "--input-type=module", "-e", VALIDA_JS, pathlib.Path(VALIDATORE).as_uri()],
                       input=raw, capture_output=True, timeout=20)
    if p.returncode:
        return "validatore rotto: " + p.stderr.decode()[-200:]
    return p.stdout.decode() or None


class Hub(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}"
        body = json.loads(raw)
        err = validatore(raw)
        RICHIESTE.append({"path": self.path, "body": body, "errore": err})
        if RIFIUTA["on"]:
            return self.manda(503, {"error": "hub giù (test)"})
        if err:
            return self.manda(400, {"error": err})
        self.manda(200, {"row": {"id": f"att-{len(RICHIESTE)}"}} if body.get("tipo") else {"ok": True})

    def manda(self, code, resp):
        data = json.dumps(resp).encode()
        self.send_response(code)
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


def messaggio(tipo, sec_fa, contenuto):
    return {"type": tipo, "timestamp": ora_iso(sec_fa), "entrypoint": "claude-desktop", "message": {"content": contenuto}}


def tool_uso(id_, nome, sec_fa, input_=None):
    return messaggio("assistant", sec_fa, [{"type": "text", "text": "Mi serve una scelta."},
                                           {"type": "tool_use", "id": id_, "name": nome, "input": input_ or {}}])


def tool_esito(id_, sec_fa):
    return messaggio("user", sec_fa, [{"type": "tool_result", "tool_use_id": id_, "content": "ok"}])


def testo_fine(sec_fa):
    return messaggio("assistant", sec_fa, [{"type": "text", "text": "Fatto."}])


def transcript(tmp, cartella, righe, quiete_s):
    """Un transcript in projects/<cartella>/<cli>.jsonl, con la quiete (mtime) indicata."""
    d = os.path.join(tmp, "projects", cartella)
    os.makedirs(d, exist_ok=True)
    tr = os.path.join(d, CLI + ".jsonl")
    with open(tr, "w") as f:
        for r in righe:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.utime(tr, (time.time() - quiete_s, time.time() - quiete_s))
    return tr


def sotto(tmp, cartella, quiete_s, nome="agent-1", meta=None):
    """Un sottoagente: il suo file sta in <cli>/subagents/, scritto quiete_s secondi fa; il meta.json, se c'è, dice per
    quale tool lavora."""
    d = os.path.join(tmp, "projects", cartella, CLI, "subagents")
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, nome + ".jsonl")
    with open(f, "w") as fh:
        fh.write('{"type": "assistant"}\n')
    os.utime(f, (time.time() - quiete_s, time.time() - quiete_s))
    if meta is not None:
        with open(os.path.join(d, nome + ".meta.json"), "w") as fh:
            json.dump(meta, fh)


def desktop_meta(tmp, account, archiviata, quiete_s):
    """Una copia dei metadati di local_aaaa in una cartella d'account, scritta quiete_s secondi fa."""
    d = os.path.join(tmp, "desktop", account, "prog")
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, "local_aaaa.json")
    with open(f, "w") as fh:
        json.dump({"sessionId": "local_aaaa", "cliSessionId": CLI, "title": "Quadra per commercialisti",
                   "isArchived": archiviata}, fh)
    os.utime(f, (time.time() - quiete_s, time.time() - quiete_s))


def scena(tmp, righe, quiete_s, cartella="-Users-x"):
    """Una sessione desktop: metadati in <account>/<progetto>/local_*.json, transcript in projects/<cartella>/."""
    os.makedirs(os.path.join(tmp, "desktop", "acc", "prog"), exist_ok=True)
    transcript(tmp, cartella, righe, quiete_s)
    meta = {"sessionId": "local_aaaa", "cliSessionId": CLI, "title": "Quadra per commercialisti", "isArchived": False}
    with open(os.path.join(tmp, "desktop", "acc", "prog", "local_aaaa.json"), "w") as f:
        json.dump(meta, f)


def gira(tmp, *args):
    stub = os.path.join(tmp, "diario-finto.mjs")  # il diario vero non si tocca: si registra su un file
    with open(stub, "w") as f:
        f.write("import fs from 'node:fs';\nfs.appendFileSync(process.env.DIARIO_LOG, process.argv[2] + '\\n');\n")
    env = dict(os.environ, SESSIONI_DESKTOP=os.path.join(tmp, "desktop"), SESSIONI_PROJECTS=os.path.join(tmp, "projects"),
               SESSIONI_LIMITE_STATE=os.path.join(tmp, "stato.json"), REGIA_NOTES=os.path.join(tmp, "nessuna-regia"),
               SESSIONI_HUB_URL=URL, SESSIONI_DIARIO=stub, DIARIO_LOG=os.path.join(tmp, "diario.log"))
    p = subprocess.run([sys.executable, "-I", SCRIPT, *args], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr


def diario(tmp):
    try:
        return open(os.path.join(tmp, "diario.log")).read().splitlines()
    except OSError:
        return []


def stato(tmp):
    return json.load(open(os.path.join(tmp, "stato.json")))


def richieste_attesa():
    return [r for r in RICHIESTE if r["body"].get("tipo") or r["body"].get("kind") == "chiudi"]


def voci():
    return [r for r in RICHIESTE if r["body"].get("tipo")]


def chiusure():
    return [r for r in RICHIESTE if r["body"].get("kind") == "chiudi"]


def sparisci(tmp):
    """La sessione sparisce del tutto: né metadati né transcript, in nessuna cartella d'account."""
    os.remove(os.path.join(tmp, "desktop", "acc", "prog", "local_aaaa.json"))
    os.remove(os.path.join(tmp, "projects", "-Users-x", CLI + ".jsonl"))


def titolo_ok(t):
    return t.endswith(": aspetta una tua risposta") and "Quadra per commercialisti" in t


def check(nome, ok, dettaglio=""):
    print(f"{'PASS' if ok else 'FAIL'}  {nome}" + ("" if ok else f"  ({dettaglio})"))
    return ok


esiti = []

# (a) domanda in sospeso da 25 minuti → una sola voce, tipo decisione, e ogni POST passa il validatore vero
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [testo_fine(3000), tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    rc, out = gira(tmp)
    v = voci()
    a_ok = rc == 0 and len(v) == 1 and v[0]["body"]["tipo"] == "decisione" and titolo_ok(v[0]["body"]["title"]) \
        and "ti ha fatto una domanda" in v[0]["body"]["why"] and v[0]["body"]["why"].startswith("da ") \
        and v[0]["body"]["link"] == "claude://claude.ai/epitaxy/local_aaaa" and v[0]["body"]["from"] == "sessioni-limite" \
        and all(r["errore"] is None for r in RICHIESTE)
    esiti.append(check("(a) domanda ferma da 25 min → una voce decisione, validatore vero: nessun rifiuto", a_ok,
                       f"rc={rc} voci={len(v)} rifiuti={[r['errore'] for r in RICHIESTE if r['errore']]} {out.strip()}"))
    # (b) stessa sessione, stessa domanda, secondo giro → nessun duplicato
    prima = len(richieste_attesa())
    gira(tmp)
    esiti.append(check("(b) secondo giro → nessun duplicato", len(richieste_attesa()) == prima, f"richieste {prima} → {len(richieste_attesa())}"))
    # (d) il risultato arriva → una sola chiusura con l'id della voce, e lo stato si svuota
    scena(tmp, [testo_fine(3000), tool_uso("toolu_domanda", "AskUserQuestion", 1500), tool_esito("toolu_domanda", 60)], quiete_s=60)
    prima = len(richieste_attesa())
    gira(tmp)
    nuove = richieste_attesa()[prima:]
    esiti.append(check("(d) risultato arrivato → una chiusura, stato svuotato",
                       len(nuove) == 1 and nuove[0]["body"] == {"kind": "chiudi", "ref": "att-1"} and not stato(tmp).get("attesa"),
                       f"nuove={[r['body'] for r in nuove]} stato={stato(tmp).get('attesa')}"))

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

# (f) Agent in foreground da 25 minuti, ma il sottoagente ha scritto un minuto fa → niente
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_agente", "Agent", 1500)], quiete_s=1500)
    sotto(tmp, "-Users-x", quiete_s=60, meta={"toolUseId": "toolu_agente"})
    gira(tmp)
    esiti.append(check("(f) Agent da 25 min, sottoagente attivo 1 min fa → nessuna voce", not richieste_attesa(),
                       f"richieste={[r['body'] for r in RICHIESTE]}"))

# (g) due transcript per la stessa sessione (cartella collegata): la copia vecchia è chiusa, la nuova è in sospeso → voce
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_vecchio", "Read", 4000), tool_esito("toolu_vecchio", 3990), testo_fine(3980)],
          quiete_s=3000, cartella="-Users-vecchio")
    transcript(tmp, "-Users-nuovo", [testo_fine(3000), tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    gira(tmp)
    esiti.append(check("(g) copia vecchia chiusa + copia nuova in sospeso → voce", len(voci()) == 1,
                       f"richieste={[r['body'] for r in RICHIESTE]}"))

# (h) tool in parallelo: Bash già risposto, Write ancora in sospeso → una voce, per il Write
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    parallelo = messaggio("assistant", 1500, [{"type": "tool_use", "id": "toolu_bash", "name": "Bash", "input": {}},
                                              {"type": "tool_use", "id": "toolu_write", "name": "Write", "input": {}}])
    scena(tmp, [parallelo, messaggio("user", 1400, [{"type": "tool_result", "tool_use_id": "toolu_bash", "content": "ok"}])],
          quiete_s=1400)
    gira(tmp)
    v = voci()
    esiti.append(check("(h) parallelo: Bash risposto, Write in sospeso → una voce, «modificare un file»",
                       len(v) == 1 and v[0]["body"]["why"].endswith("aspetta il tuo permesso per modificare un file")
                       and v[0]["body"]["link"] == "claude://claude.ai/epitaxy/local_aaaa", f"voci={[r['body'] for r in v]}"))

# (i) Write da 70 KB come ultima riga: la finestra di 64 KB non basta, si rilegge a 1 MB e la voce c'è
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_grande", "Write", 1500, {"content": "x" * 70000})], quiete_s=1500)
    dim = os.path.getsize(os.path.join(tmp, "projects", "-Users-x", CLI + ".jsonl"))
    gira(tmp)
    v = voci()
    esiti.append(check("(i) ultima riga da 70 KB → si rilegge a 1 MB, voce «modificare un file»",
                       dim > 64000 and len(v) == 1 and v[0]["body"]["why"].endswith("modificare un file"), f"dim={dim} voci={len(v)}"))

# (j) tool in sospeso da 49 ore → abbandonato, niente voce
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_vecchissimo", "Bash", 49 * 3600)], quiete_s=49 * 3600)
    gira(tmp)
    esiti.append(check("(j) tool in sospeso da 49 ore → nessuna voce", not richieste_attesa(), f"richieste={[r['body'] for r in RICHIESTE]}"))

# (k) sospeso da 26 ore: fuori da oggi, il perché porta la data
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_ieri", "AskUserQuestion", 26 * 3600)], quiete_s=26 * 3600)
    gira(tmp)
    v = voci()
    esiti.append(check("(k) sospeso da ieri → il perché porta la data",
                       len(v) == 1 and re.match(r"^da \d{2}/\d{2} \d{2}:\d{2} ti ha fatto una domanda$", v[0]["body"]["why"]),
                       f"voci={[r['body'] for r in v]}"))

# (l) --dry-run: stampa i limiti e gli «aspetta Attilio» trovati, senza mandare niente
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    rc, out = gira(tmp, "--dry-run")
    try:
        d = json.loads(out)
        trovati = [p["cosa"] for p in d.get("aspetta", [])]
    except ValueError:
        trovati = []
    esiti.append(check("(l) --dry-run stampa gli «aspetta Attilio», non invia nulla",
                       rc == 0 and trovati == ["ti ha fatto una domanda"] and not RICHIESTE, f"rc={rc} out={out[:200]} richieste={len(RICHIESTE)}"))

# (m) riga del transcript con U+2028 dentro il testo: non va spezzata (splitlines la spezzava)
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    riga = messaggio("assistant", 1500, [{"type": "text", "text": "Riga\u2028spezzata"},
                                         {"type": "tool_use", "id": "toolu_u", "name": "Bash", "input": {}}])
    scena(tmp, [riga], quiete_s=1500)
    gira(tmp)
    v = voci()
    esiti.append(check("(m) U+2028 nel testo → la riga resta intera, voce «un comando»",
                       len(v) == 1 and v[0]["body"]["why"].endswith("un comando"), f"voci={[r['body'] for r in v]}"))

# (n) hub giù: una riga nel diario alla prima rottura, non una per giro; al ritorno la voce passa
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    RIFIUTA["on"] = True
    gira(tmp)
    gira(tmp)
    righe_diario = diario(tmp)
    RIFIUTA["on"] = False
    rc, out = gira(tmp)
    esiti.append(check("(n) hub giù: una riga nel diario per voce, poi la voce passa al ritorno",
                       len(righe_diario) == 1 and "non è passata" in righe_diario[0] and rc == 0
                       and bool(stato(tmp).get("attesa")) and not stato(tmp).get("fallite"),
                       f"diario={righe_diario} stato={stato(tmp)}"))

# (g2) specchio di (g): la copia nuova (chiusa) sta nella cartella che viene prima nell'ordine di glob, la vecchia è in sospeso
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_nuovo", "Read", 1500), tool_esito("toolu_nuovo", 1490), testo_fine(1480)],
          quiete_s=1500, cartella="-Users-aaa")
    transcript(tmp, "-Users-zzz", [tool_uso("toolu_vecchio", "AskUserQuestion", 4000)], quiete_s=3000)
    gira(tmp)
    esiti.append(check("(g2) copia nuova chiusa, vecchia in sospeso → nessuna voce", not richieste_attesa(),
                       f"richieste={[r['body'] for r in RICHIESTE]}"))

# (o) tool MCP: conta l'ultima parte del nome (mcp__computer-use__request_access → «usare un'app», non «un'azione»)
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_app", "mcp__computer-use__request_access", 1500)], quiete_s=1500)
    gira(tmp)
    v = voci()
    esiti.append(check("(o) tool MCP request_access → «per usare un'app»",
                       len(v) == 1 and v[0]["body"]["why"].endswith("aspetta il tuo permesso per usare un'app"),
                       f"voci={[r['body'] for r in v]}"))

# (p) sottoagenti scritti da poco ma non per il tool in attesa (altro toolUseId, o in background) non rimandano l'avviso
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_agente", "Agent", 1500)], quiete_s=1500)
    sotto(tmp, "-Users-x", quiete_s=60, nome="agent-altro", meta={"toolUseId": "toolu_altro"})
    sotto(tmp, "-Users-x", quiete_s=60, nome="agent-bg", meta={"requestShape": "background"})
    gira(tmp)
    esiti.append(check("(p) sottoagenti scritti da poco ma non in attesa → la voce c'è lo stesso", len(voci()) == 1,
                       f"richieste={[r['body'] for r in RICHIESTE]}"))

# (q) stessa sessione in due cartelle d'account: vale la copia con il file più recente, e archiviata lì è archiviata
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    desktop_meta(tmp, "acc", archiviata=False, quiete_s=5000)
    desktop_meta(tmp, "nuovo", archiviata=True, quiete_s=0)
    gira(tmp)
    esiti.append(check("(q) due copie, la più recente archiviata → nessuna voce", not richieste_attesa(),
                       f"richieste={[r['body'] for r in RICHIESTE]}"))

# (r) l'ultima riga del transcript è tagliata (sta scrivendo): la voce già aperta non si chiude
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    gira(tmp)
    prima = len(richieste_attesa())
    tr = os.path.join(tmp, "projects", "-Users-x", CLI + ".jsonl")
    with open(tr, "w") as f:
        f.write(json.dumps(testo_fine(3000)) + "\n")
        f.write('{"type": "assistant", "timestamp": "' + ora_iso(1500) + '", "message": {"content": [{"type": "tool_use", "id": "toolu_domanda"')
    os.utime(tr, (time.time() - 1500, time.time() - 1500))
    gira(tmp)
    esiti.append(check("(r) ultima riga del transcript tagliata → la voce aperta non si chiude",
                       prima == 1 and len(richieste_attesa()) == prima and bool(stato(tmp).get("attesa")),
                       f"prima={prima} dopo={len(richieste_attesa())} stato={stato(tmp).get('attesa')}"))

# (s) metadati illeggibili (file in scrittura): la voce già aperta non si chiude
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    gira(tmp)
    prima = len(richieste_attesa())
    with open(os.path.join(tmp, "desktop", "acc", "prog", "local_aaaa.json"), "w") as f:
        f.write('{"sessionId": "loc')
    gira(tmp)
    esiti.append(check("(s) metadati illeggibili → la voce aperta non si chiude",
                       prima == 1 and len(richieste_attesa()) == prima and bool(stato(tmp).get("attesa")),
                       f"prima={prima} dopo={len(richieste_attesa())} stato={stato(tmp).get('attesa')}"))

# (t) sottoagente in attesa: la frase dice che aspetta il permesso lui, non «per avviare un sottoagente»
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_agente", "Agent", 1500)], quiete_s=1500)
    gira(tmp)
    v = voci()
    esiti.append(check("(t) Agent in attesa → «un sottoagente aspetta il tuo permesso»",
                       len(v) == 1 and v[0]["body"]["why"].endswith("un sottoagente aspetta il tuo permesso"),
                       f"voci={[r['body'] for r in v]}"))

# (u) una voce non passata, poi la sessione si risolve: la chiave non resta in «fallite»
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    RIFIUTA["on"] = True
    gira(tmp)
    RIFIUTA["on"] = False
    prima_fallite = stato(tmp).get("fallite")
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500), tool_esito("toolu_domanda", 60)], quiete_s=60)
    gira(tmp)
    esiti.append(check("(u) voce non passata, poi sessione risolta → «fallite» si svuota",
                       bool(prima_fallite) and not stato(tmp).get("fallite"), f"prima={prima_fallite} dopo={stato(tmp).get('fallite')}"))

# (v) sessione sparita del tutto (né metadati né transcript in nessuna cartella d'account): la voce si chiude solo al terzo giro
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    gira(tmp)
    sparisci(tmp)
    gira(tmp)
    gira(tmp)
    dopo_due = len(chiusure())
    gira(tmp)
    esiti.append(check("(v) sparita: due giri → nessuna chiusura", dopo_due == 0, f"chiusure dopo 2 giri={dopo_due}"))
    esiti.append(check("(v) sparita: tre giri → una sola chiusura, con l'id della voce, e lo stato si svuota",
                       len(chiusure()) == 1 and chiusure()[0]["body"].get("ref") == "att-1" and not stato(tmp).get("attesa"),
                       f"chiusure={[r['body'] for r in chiusure()]} stato={stato(tmp).get('attesa')}"))

# (w) sparita, poi torna, poi sparisce di nuovo: il contatore riparte da zero, due giri non chiudono
with tempfile.TemporaryDirectory() as tmp:
    RICHIESTE.clear()
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    gira(tmp)
    sparisci(tmp)
    gira(tmp)
    gira(tmp)
    scena(tmp, [tool_uso("toolu_domanda", "AskUserQuestion", 1500)], quiete_s=1500)
    gira(tmp)
    sparisci(tmp)
    gira(tmp)
    gira(tmp)
    esiti.append(check("(w) sparita, torna, sparisce: due giri dopo il ritorno → nessuna chiusura",
                       len(chiusure()) == 0, f"chiusure={[r['body'] for r in chiusure()]}"))
    gira(tmp)
    esiti.append(check("(w) il terzo giro dopo il ritorno chiude",
                       len(chiusure()) == 1, f"chiusure={[r['body'] for r in chiusure()]}"))

HUB.shutdown()
ok = all(esiti)
print("PASS tutti i casi" if ok else f"FAIL {esiti.count(False)} caso/i rosso/i")
sys.exit(0 if ok else 1)
PY
