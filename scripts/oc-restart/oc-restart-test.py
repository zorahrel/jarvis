#!/usr/bin/env python3
"""Barra di oc-restart: con lavoro in corso NON riavvia (si stacca e aspetta), a gateway libero riavvia,
con --now riavvia comunque. Nessun riavvio vero: restart(), Popen e le letture sono finti.
Mutazione: OC_RESTART_SRC=<copia vecchia> deve far fallire il primo caso."""
import importlib.machinery, importlib.util, os, sys
from pathlib import Path

SRC = os.environ.get("OC_RESTART_SRC", str(Path(__file__).resolve().parent / "oc-restart"))
ok = ko = 0


def load():
    loader = importlib.machinery.SourceFileLoader("ocr", SRC)
    spec = importlib.util.spec_from_loader("ocr", loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    return m


def scenario(name, argv, busy, want_restart, want_detach):
    global ok, ko
    m = load()
    calls = {"restart": 0, "popen": 0}
    m.STATE = Path(os.environ.get("TMPDIR", "/tmp")) / "oc-restart-test-state"
    m.blockers = lambda: busy
    m.running = lambda: []
    m.replying = lambda: []
    m.log_request = lambda *a: None
    m.wait_replies = lambda dry: None
    m.resume = lambda *a: []
    m.discord_catchup = lambda *a: []
    m.lost_since = lambda ms: []
    m.time.sleep = lambda s: None

    def fake_restart():
        calls["restart"] += 1
        return m.time.time()
    m.restart = fake_restart

    class P:
        def __init__(self, *a, **k):
            calls["popen"] += 1
    m.subprocess.Popen = P
    sys.argv = ["oc-restart"] + argv
    try:
        m.main()
    except SystemExit:
        pass
    got = (calls["restart"] > 0, calls["popen"] > 0)
    if got == (want_restart, want_detach):
        ok += 1; print("  ok  ", name)
    else:
        ko += 1; print(f"  FAIL {name}: restart/detach atteso {(want_restart, want_detach)}, avuto {got}")


scenario("lavoro in corso: non riavvia, si stacca", [], [("sottoagente", "x")], False, True)
scenario("chat che risponde: non riavvia, si stacca", [], [("chat", "agent:main:whatsapp:direct:+39")], False, True)
scenario("gateway libero: riavvia subito", [], [], True, False)
scenario("--now con lavoro in corso: riavvia", ["--now"], [("sottoagente", "x")], True, False)


def wait_case(name, seq, max_wait, want):
    """wait_idle con orologio finto: seq = elenco bloccanti a ogni giro (l'ultimo si ripete)."""
    global ok, ko
    m = load()
    clock = {"t": 1000.0}
    it = iter(seq)
    last = [seq[-1]]

    def blockers():
        try:
            last[0] = next(it)
        except StopIteration:
            pass
        return last[0]
    m.blockers = blockers
    m.time.time = lambda: clock["t"]
    m.time.sleep = lambda s: clock.__setitem__("t", clock["t"] + s)
    got = m.wait_idle(max_wait)
    if got == want:
        ok += 1; print("  ok  ", name)
    else:
        ko += 1; print(f"  FAIL {name}: atteso {want}, avuto {got}")


B, F = [("sottoagente", "x")], []
wait_case("occupato poi libero a lungo: riparte", [B, B, F], 600, True)
wait_case("libero solo un attimo, poi di nuovo occupato: aspetta ancora", [F, B, B, B, F], 600, True)
wait_case("sempre occupato: scade, non riavvia", [B], 300, False)
print(f"{ok} ok, {ko} FAIL")
sys.exit(1 if ko else 0)
