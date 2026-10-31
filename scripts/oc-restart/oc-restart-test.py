#!/usr/bin/env python3
"""Barra di oc-restart: con lavoro in corso NON riavvia (si stacca e aspetta), a gateway libero riavvia,
con --now riavvia comunque. Nessun riavvio vero: restart(), Popen e le letture sono finti.
Mutazione: OC_RESTART_SRC=<copia vecchia> deve far fallire il primo caso."""
import importlib.machinery, importlib.util, json, os, subprocess, sys, time
from pathlib import Path

SRC = os.environ.get("OC_RESTART_SRC", str(Path(__file__).resolve().parent / "oc-restart"))
ok = ko = 0


def load():
    loader = importlib.machinery.SourceFileLoader("ocr", SRC)
    spec = importlib.util.spec_from_loader("ocr", loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    return m


class Shim:
    """Doppio locale di un modulo (time, subprocess): vive solo dentro la copia caricata di oc-restart e non
    tocca mai il modulo vero, quindi non resta niente da ripristinare per il resto della suite."""
    def __init__(self, real, **over):
        self._real = real
        self.__dict__.update(over)

    def __getattr__(self, k):
        return getattr(self._real, k)


def clock(now=None):
    """Orologio finto (now fisso) o quello vero se now e' None; sleep sempre istantaneo."""
    over = {"sleep": lambda s: None}
    if now is not None:
        over["time"] = lambda: now
    return Shim(time, **over)


STATE_DIR = Path(os.environ.get("TMPDIR", "/tmp")) / "oc-restart-test-state"
REAL = (time.time, time.sleep, subprocess.run, subprocess.Popen)


def setup(m, now=None):
    """Isola la copia caricata: stato in una cartella di prova, niente riavvio, niente processi, niente letture vere."""
    m.STATE = STATE_DIR
    m.WAITER_PID = m.STATE / "w.pid"  # mai il pid file vero
    m.REQUESTED_FILE = m.STATE / "w.requested"  # mai il file vero dei riferimenti
    m.REQUESTED_FILE.unlink(missing_ok=True)
    m.running = lambda: []
    m.replying = lambda: []
    m.log_request = lambda *a: None
    m.wait_replies = lambda dry: None
    m.resume = lambda *a: []
    m.discord_catchup = lambda *a: []
    m.lost_since = lambda ms: []
    m.wait_idle = lambda: True
    m.time = clock(now)


class Fake:
    """Risultato finto di Popen/run: solo gli attributi che servono."""
    def __init__(self, **kw):
        self.__dict__.update(kw)


def scenario(name, argv, busy, want_restart, want_detach, started=None, want_msg=None, now=None,
             requests=(), file_before=None, alive=0, want_file=None):
    """requests = (ora, argv) di richieste precedenti fatte dal padre (processo in attesa gia' vivo, orologio finto);
    file_before = contenuto del file dei riferimenti prima del giro; want_file = valore atteso (a +-5 s) dopo."""
    global ok, ko
    m = load()
    calls = {"restart": 0, "popen": 0}
    setup(m, now)
    m.blockers = lambda: busy
    m.waiter_alive = lambda: alive
    m.gateway_started_at = lambda: started
    m.restart = lambda: calls.__setitem__("restart", calls["restart"] + 1) or 0
    m.subprocess = Shim(subprocess, Popen=lambda *a, **k: calls.__setitem__("popen", calls["popen"] + 1) or Fake(pid=777))
    import contextlib, io
    buf = io.StringIO()

    def go(argv_):
        sys.argv = ["oc-restart"] + argv_
        try:
            with contextlib.redirect_stdout(buf):
                m.main()
        except SystemExit:
            pass
    for t, av in requests:  # padre che trova il processo in attesa gia' vivo
        m.time = clock(t)
        m.waiter_alive = lambda: 4242
        m.blockers = lambda: [("sottoagente", "x")]
        go(av)
    m.blockers = lambda: busy
    m.time = clock(now)
    m.waiter_alive = lambda: alive
    if file_before is not None:
        m.STATE.mkdir(parents=True, exist_ok=True)
        m.REQUESTED_FILE.write_text(str(file_before))
    calls["restart"] = calls["popen"] = 0
    t_call = time.time()
    go(argv)
    got = (calls["restart"] > 0, calls["popen"] > 0)
    written = m.read_requested()
    if want_msg and want_msg not in buf.getvalue():
        ko += 1; print(f"  FAIL {name}: manca «{want_msg}» nell'output: {buf.getvalue()!r}")
    elif want_file is not None and abs(written - (t_call if want_file == "adesso" else want_file)) > 5:
        ko += 1; print(f"  FAIL {name}: riferimento scritto {written}, atteso {want_file} (adesso = {t_call})")
    elif got == (want_restart, want_detach):
        ok += 1; print("  ok  ", name)
    else:
        ko += 1; print(f"  FAIL {name}: restart/detach atteso {(want_restart, want_detach)}, avuto {got}")


def unit(name, cond):
    global ok, ko
    if cond:
        ok += 1; print("  ok  ", name)
    else:
        ko += 1; print("  FAIL", name)


def active(stdout):
    m = load()
    class R:
        pass
    r = R(); r.stdout = stdout
    m.subprocess = Shim(subprocess, run=lambda *a, **k: r)
    return m.active_work()


unit("contatore gateway: un turno in volo blocca", active('{"shutdownBudget":{"activeWork":{"rootRequests":1,"cronRuns":0}}}') == [("gateway", "rootRequests 1")])
unit("contatore gateway: tutto a zero non blocca", active('{"shutdownBudget":{"activeWork":{"rootRequests":0,"cronRuns":0}}}') == [])
unit("contatore gateway: gateway muto non blocca", active('') == [])


def etime_case():
    """gateway_started_at legge etime di ps: mm:ss, hh:mm:ss e gg-hh:mm:ss."""
    m = load()
    m.gateway_pid = lambda: "1"
    m.time = clock(1000000.0)
    class R:
        pass
    res = []
    for et, secs in (("05:07", 307), ("02:05:07", 7507), ("3-02:05:07", 266707)):
        r = R(); r.stdout = f"  {et}\n"
        m.subprocess = Shim(subprocess, run=lambda *a, **k: r)
        res.append(m.gateway_started_at() == 1000000.0 - secs)
    return all(res)


unit("avvio del gateway da etime (mm:ss, hh:mm:ss, gg-hh:mm:ss)", etime_case())


def lock_case():
    m = load()
    m.STATE = Path(os.environ.get("TMPDIR", "/tmp")) / "oc-restart-test-state"
    m.STATE.mkdir(parents=True, exist_ok=True)
    m.WAITER_PID = m.STATE / "w.pid"
    m.WAITER_PID.write_text(str(os.getpid()))
    alive = m.waiter_alive() == os.getpid()
    m.WAITER_PID.write_text("999999")
    return alive and m.waiter_alive() == 0


unit("un solo processo in attesa (pid vivo sì, morto no)", lock_case())

scenario("lavoro in corso: non riavvia, si stacca", [], [("sottoagente", "x")], False, True)
scenario("chat che risponde: non riavvia, si stacca", [], [("chat", "agent:main:whatsapp:direct:+39")], False, True)
scenario("gateway libero: riavvia subito", [], [], True, False)
scenario("--now con lavoro in corso: riavvia", ["--now"], [("sottoagente", "x")], True, False)
# (b) il padre registra l'istante della propria chiamata (orologio vero, +-5 s): un istante sbagliato esce rosso
scenario("padre che si stacca: registra l'istante della richiesta", [], [("sottoagente", "x")], False, True,
         want_file="adesso")
scenario("padre con processo in attesa vivo: registra l'istante della nuova richiesta", [], [("sottoagente", "x")],
         False, False, alive=4242, want_file="adesso", file_before=1.0)
# processo in attesa: riferimento nel file = 1000, gateway partito alle 2000 (dopo) o alle 500 (prima)
scenario("in attesa, gateway partito dopo la richiesta: non riavvia", ["--wait-idle"], [], False, False,
         file_before=1000.0, started=2000.0, want_msg="già caricato")
scenario("in attesa, gateway partito prima della richiesta: riavvia", ["--wait-idle"], [], True, False,
         file_before=1000.0, started=500.0)
scenario("in attesa a mano, senza riferimento: riavvia", ["--wait-idle"], [], True, False, started=2000.0)
# (a) richiesta A (1000), gateway riparte (2000), richiesta B (3000) con il processo in attesa vivo: B va servita
scenario("seconda richiesta dopo un riavvio spontaneo: il processo in attesa riavvia", ["--wait-idle"], [], True, False,
         requests=[(1000.0, []), (3000.0, [])], started=2000.0, now=3500.0)
# ...ma se il gateway riparte dopo l'ultima richiesta, le serve entrambe
scenario("gateway ripartito dopo l'ultima richiesta: non riavvia", ["--wait-idle"], [], False, False,
         requests=[(1000.0, []), (3000.0, [])], started=4000.0, now=5000.0, want_msg="già caricato")
# (c) --since EPOCH
scenario("--since, gateway partito dopo: non riavvia (percorso diretto)", ["--since", "1000"], [], False, False,
         started=2000.0, want_msg="già caricato: gateway partito alle")
scenario("--since, gateway partito dopo, con lavoro in corso: non riavvia e non si stacca", ["--since", "1000"],
         [("sottoagente", "x")], False, False, started=2000.0, want_msg="dopo il riferimento")
scenario("--since, gateway partito prima: riavvia", ["--since", "3000"], [], True, False, started=2000.0)
scenario("--now --since, gateway partito dopo: non riavvia", ["--now", "--since", "1000"], [], False, False, started=2000.0)
scenario("--since, gateway partito prima, lavoro in corso: si stacca e registra il riferimento", ["--since", "3000"],
         [("sottoagente", "x")], False, True, started=2000.0, want_file=3000.0)
scenario("--since nel processo in attesa, gateway partito dopo: non riavvia", ["--wait-idle", "--since", "1000"], [], False,
         False, started=2000.0, want_msg="già caricato")
scenario("--since nel processo in attesa, gateway partito prima: riavvia", ["--wait-idle", "--since", "3000"], [], True,
         False, started=2000.0)
scenario("--since senza valore: non riavvia", ["--since"], [], False, False)
scenario("senza --since il comportamento resta: gateway su da prima, libero, riavvia", [], [], True, False, started=2000.0)


def replying_case():
    """(d) openclaw sessions oltre il timeout: replying() non solleva, conta come occupato e lascia una riga."""
    m = load()
    def boom(*a, **k):
        raise subprocess.TimeoutExpired(a[0], 60)
    m.subprocess = Shim(subprocess, run=boom)
    import contextlib, io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            busy = m.replying()
        except subprocess.TimeoutExpired:
            return False
    return bool(busy) and "oltre 60 s" in buf.getvalue()


unit("openclaw sessions in timeout: occupato, riprovo, una riga nel registro", replying_case())


def waiter_pid_case():
    """(1) Il processo in attesa libera il pid file appena consuma la richiesta, PRIMA di restart(): una richiesta B
    arrivata durante il riavvio deve poter lanciare il suo processo. Se nel frattempo un altro processo in attesa ha
    scritto il proprio pid, all'uscita non va cancellato. Il pid file vero non si tocca (setup lo sposta)."""
    import contextlib, io
    seen = {}
    for name, other in (("proprio", None), ("altrui", "31337")):
        m = load()
        setup(m)
        m.blockers = lambda: []
        m.gateway_started_at = lambda: 500.0
        m.STATE.mkdir(parents=True, exist_ok=True)
        m.WAITER_PID.write_text(str(os.getpid()))
        m.REQUESTED_FILE.write_text("1000")

        def fake_restart():
            seen[name + "_pid_in_restart"] = m.WAITER_PID.exists()
            if other:
                m.WAITER_PID.write_text(other)  # una richiesta B ha lanciato un altro processo in attesa
            return 0
        m.restart = fake_restart
        sys.argv = ["oc-restart", "--wait-idle"]
        with contextlib.redirect_stdout(io.StringIO()):
            m.main()
        seen[name + "_pid_after"] = m.WAITER_PID.read_text() if m.WAITER_PID.exists() else None
    unit("in attesa: pid file libero prima di restart(), non esiste a fine giro", not seen["proprio_pid_in_restart"] and seen["proprio_pid_after"] is None)
    unit("in attesa: il pid di un altro processo in attesa non viene cancellato all'uscita", seen["altrui_pid_after"] == "31337")

    # anche quando esce senza riavviare (gateway gia' ripartito dopo la richiesta)
    m = load()
    setup(m)
    m.blockers = lambda: []
    m.gateway_started_at = lambda: 2000.0
    m.WAITER_PID.write_text(str(os.getpid()))
    m.REQUESTED_FILE.write_text("1000")
    sys.argv = ["oc-restart", "--wait-idle"]
    with contextlib.redirect_stdout(io.StringIO()):
        m.main()
    unit("in attesa: uscita senza riavvio libera comunque il pid file", not m.WAITER_PID.exists())


def parent_pid_case():
    """(2) Il padre scrive il pid del processo lanciato subito, senza aspettare che il figlio parta: la seconda richiesta
    lo trova e non ne lancia un altro."""
    import contextlib, io
    m = load()
    setup(m)
    m.blockers = lambda: [("sottoagente", "x")]
    m.waiter_alive = lambda: 0
    m.subprocess = Shim(subprocess, Popen=lambda *a, **k: Fake(pid=777))
    sys.argv = ["oc-restart"]
    with contextlib.redirect_stdout(io.StringIO()):
        m.main()
    got = m.WAITER_PID.read_text() if m.WAITER_PID.exists() else None
    m.WAITER_PID.unlink(missing_ok=True)
    return got == "777"


unit("padre che lancia il processo in attesa: scrive subito il suo pid", parent_pid_case())
waiter_pid_case()


def active_timeout_case():
    """(4) openclaw gateway call status oltre il timeout: active_work() non solleva (uccideva il processo in attesa),
    conta come occupato e lascia una riga."""
    import contextlib, io
    m = load()
    def boom(*a, **k):
        raise subprocess.TimeoutExpired(a[0], 90)
    m.subprocess = Shim(subprocess, run=boom)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            busy = m.active_work()
        except subprocess.TimeoutExpired:
            return False
    return bool(busy) and "oltre 90 s" in buf.getvalue()


unit("gateway call status in timeout: occupato, riprovo, una riga nel registro", active_timeout_case())


def wait_case(name, seq, max_wait, want):
    """wait_idle con orologio finto: seq = elenco bloccanti a ogni giro (l'ultimo si ripete)."""
    global ok, ko
    m = load()
    clock = {"t": 1000.0}  # orologio di questo caso (la funzione clock() sopra e' un'altra cosa)
    it = iter(seq)
    last = [seq[-1]]

    def blockers():
        try:
            last[0] = next(it)
        except StopIteration:
            pass
        return last[0]
    m.blockers = blockers
    m.time = Shim(time, time=lambda: clock["t"], sleep=lambda s: clock.__setitem__("t", clock["t"] + s))
    got = m.wait_idle(max_wait)
    if got == want:
        ok += 1; print("  ok  ", name)
    else:
        ko += 1; print(f"  FAIL {name}: atteso {want}, avuto {got}")


B, F = [("sottoagente", "x")], []
wait_case("occupato poi libero a lungo: riparte", [B, B, F], 600, True)
wait_case("libero solo un attimo, poi di nuovo occupato: aspetta ancora", [F, B, B, B, F], 600, True)
wait_case("sempre occupato: scade, non riavvia", [B], 300, False)


def age_case():
    """(5) --dry-run elenca ogni cosa in corso con la sua eta': un sottoagente di 3 ore e uno appena nato si
    distinguono a vista (28/10: il riavvio a gateway libero non partiva mai e non si capiva da cosa)."""
    import contextlib, io, sqlite3, tempfile
    now = 1_800_000_000.0
    db = Path(tempfile.mkdtemp()) / "t.sqlite"
    con = sqlite3.connect(db)
    con.execute("create table cron_run_receipts (job_id text, status text, started_at_ms integer)")
    con.execute("insert into cron_run_receipts values ('abcdef0123', 'running', ?)", ((now - 25 * 60) * 1000,))
    con.commit(); con.close()
    m = load()
    setup(m, now)
    m.DB = db
    m.active_work = lambda: [("gateway", "rootRequests 3")]
    m.running = lambda: [{"label": "Lavoro T3", "execution": {"startedAt": (now - 171 * 60) * 1000}},
                         {"label": "Logo", "createdAt": (now - 5 * 60) * 1000, "execution": {}}]
    # replying() VERO, con un «openclaw sessions» finto che porta ageMs: cosi' il ramo dell'eta' delle chat gira davvero
    chats = load()
    sessions = {"sessions": [{"key": "agent:main:whatsapp:direct:+39", "status": "running", "ageMs": 2 * 60000},
                             {"key": "agent:main:subagent:x", "status": "running", "ageMs": 9 * 60000}]}
    chats.subprocess = Shim(subprocess, run=lambda *a, **k: Fake(stdout=json.dumps(sessions)))
    m.replying = chats.replying
    got = m.blockers()
    buf = io.StringIO()
    sys.argv = ["oc-restart", "--dry-run"]
    with contextlib.redirect_stdout(buf):
        m.main()
    out = buf.getvalue()
    return (("sottoagente", "Lavoro T3 (da 2 h 51 min)") in got and ("sottoagente", "Logo (da 5 min)") in got
            and ("cron", "abcdef01 (da 25 min)") in got
            and ("chat", "agent:main:whatsapp:direct:+39 (aggiornata 2 min fa)") in got
            and not any("subagent:x" in v for k, v in got if k == "chat")
            and out.startswith("5 cose in corso:\n")
            and "  - chat: agent:main:whatsapp:direct:+39 (aggiornata 2 min fa)\n" in out
            and "  - cron: abcdef01 (da 25 min)\n" in out and "  - sottoagente: Lavoro T3 (da 2 h 51 min)\n" in out)


def free_case():
    """(5b) gateway libero: la prima riga resta «0 cose», e' quella che oc-memwatch cerca per decidere."""
    import contextlib, io
    m = load()
    setup(m, 1_800_000_000.0)
    m.blockers = lambda: []
    buf = io.StringIO()
    sys.argv = ["oc-restart", "--dry-run"]
    with contextlib.redirect_stdout(buf):
        m.main()
    return buf.getvalue().startswith("0 cose")


unit("--dry-run: ogni cosa in corso con la sua eta' (sottoagenti, cron, chat)", age_case())
unit("--dry-run a gateway libero: la riga comincia ancora per «0 cose»", free_case())
unit("età leggibile: 45 min, 1 h 05 min, 2 h 51 min", [getattr(load(), "age_text", lambda ms: None)(x * 60000) for x in (45, 65, 171)] == ["45 min", "1 h 05 min", "2 h 51 min"])
# (e) i doppi non sono usciti dalle copie caricate: i moduli veri sono intatti
unit("nessun doppio resta su time e subprocess veri", REAL == (time.time, time.sleep, subprocess.run, subprocess.Popen))
print(f"{ok} ok, {ko} FAIL")
sys.exit(1 if ko else 0)
