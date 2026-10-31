#!/usr/bin/env python3
"""Suite della regola «tsserver gonfio» di devreap: tabella ps finta, footprint iniettato, e un giro con
un processo vero: un tsserver staccato con padrone vivo non viene toccato da nessuna delle due regole.

Si chiude solo un tsserver di una sessione viva, del nostro utente, fermo (CPU a zero), sopra la soglia di
memoria e per TSSERVER_PASSES passate di fila. Mutazioni: tolta la soglia, il tsserver piccolo verrebbe
chiuso; tolti i passaggi, il primo giro basterebbe. La suite deve fallire.

    python3 -I devreap-tsserver-test.py        exit 0 = verde e mutanti visti
"""
import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SRC = Path(__file__).resolve().parent / "devreap"
MUTATIONS = [
    ("tolta la soglia di memoria", "fp_of(pid) <= TSSERVER_MB", "fp_of(pid) <= -1"),
    ("tolti i passaggi di fila", "if new[key] >= TSSERVER_PASSES:", "if new[key] >= 1:"),
    ("tolto il controllo della CPU", "i[\"cpu\"] >= TSSERVER_CPU or ", ""),
]
RAW = b"""\
    1     0     0   0.0 9-01:00:00 Fri Oct 16 10:00:00 2026 /sbin/launchd
  100  5000   501   0.0    05:00 Sun Oct 25 14:50:00 2026 node /x/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot
  101  5000   501   0.0    05:00 Sun Oct 25 14:50:00 2026 node /x/node_modules/typescript/lib/tsserver.js --small
  102  5000   501  35.0    05:00 Sun Oct 25 14:50:00 2026 node /x/node_modules/typescript/lib/tsserver.js --busy
  103  5000     0   0.0    05:00 Sun Oct 25 14:50:00 2026 node /x/node_modules/typescript/lib/tsserver.js --altro-utente
  104     1   501   0.0    05:00 Sun Oct 25 14:50:00 2026 node /x/node_modules/typescript/lib/tsserver.js --orfano
  105  5000   501   0.0    05:00 Sun Oct 25 14:50:00 2026 node /x/server.js --non-ts
"""
FP = {100: 5000, 101: 400, 102: 5000, 103: 5000, 104: 5000, 105: 5000}


def load(text=None):
    os.environ.pop("DEVREAP_ONLY_PATH", None)
    loader = importlib.machinery.SourceFileLoader("devreap_ts", str(SRC))
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("devreap_ts", loader))
    if text is None:
        loader.exec_module(mod)
    else:
        exec(compile(text, str(SRC), "exec"), mod.__dict__)
    return mod


def run(mod, real=False):
    fails = 0

    def check(cond, msg):
        nonlocal fails
        print(f"  {'ok  ' if cond else 'FAIL'} {msg}")
        fails += not cond

    procs = mod.ps_table(RAW)
    counts = {}
    for n in (1, 2):
        reap, counts = mod.tsserver_decide(procs, 501, FP.get, counts)
        check(reap == [], f"passata {n}: ancora niente, servono {mod.TSSERVER_PASSES} passate di fila")
    reap, counts = mod.tsserver_decide(procs, 501, FP.get, counts)
    check([p for p, _ in reap] == [100],
          f"alla terza passata solo il tsserver gonfio, fermo e di sessione viva: {[p for p, _ in reap]}")
    # un giro in cui il tsserver non e' piu' gonfio azzera il conto
    _, counts2 = mod.tsserver_decide(procs, 501, lambda p: 10, counts)
    check(counts2 == {}, "sotto soglia il conto riparte da zero")

    if not real:
        return fails
    # Processi veri: un finto tsserver staccato (ppid 1) con la cwd cancellata e' un resto, non un tsserver gonfio.
    tmp = tempfile.mkdtemp()
    work = Path(tmp) / "cwd"
    work.mkdir()
    pidf = Path(tmp) / "pid"
    code = f"require('fs').writeFileSync('{pidf}', String(process.pid)); setTimeout(()=>{{}}, 60000)"
    subprocess.run(["sh", "-c", f"cd '{work}' && (node -e \"{code}\" tsserver.js >/dev/null 2>&1 &)"], check=True)
    for _ in range(50):
        if pidf.exists():
            break
        time.sleep(0.1)
    pid = int(pidf.read_text())
    try:
        shutil.rmtree(work)
        time.sleep(0.3)
        live = mod.ps_table()
        check(pid in live and mod.TSSERVER.search(live[pid]["cmd"]), "il finto tsserver e' visibile nella ps vera")
        check(live[pid]["ppid"] == 1, "staccato: ppid 1")
        reap, _ = mod.tsserver_decide(live, os.getuid(), lambda p: 9999, {})
        check(pid not in [p for p, _ in reap], "il tsserver orfano non e' affare di questa regola (lo prende quella dei resti)")
        out = subprocess.run([sys.executable, "-I", str(SRC), "--list"], capture_output=True, text=True,
                             env={**os.environ, "DEVREAP_RESTO_KILL": "0"}, timeout=120).stdout
        # Il finto tsserver non ha un padrone vivo: e' staccato (ppid 1) con la cwd cancellata, quindi per
        # la regola dei resti e' un resto (osservo). Il --list non lo deve proporre come tsserver gonfio.
        riga = [l for l in out.splitlines() if f"pid={pid} " in l]
        check(all("tsserver gonfio" not in l for l in riga), "devreap --list non lo propone come tsserver gonfio")
        check(all("resto" in l and "osservo" in l for l in riga), "il --list lo mostra solo come resto in osservazione")
        try:
            os.kill(pid, 0)
            check(True, "dopo il giro il processo e' ancora vivo (osservazione)")
        except OSError:
            check(False, "il processo non doveva morire")
    finally:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
        shutil.rmtree(tmp, ignore_errors=True)
    return fails


def main():
    print("== tsserver gonfio: la suite sul codice vero")
    fails = run(load(), real=True)
    text, missed = SRC.read_text(), 0
    for name, old, new in MUTATIONS:
        print(f"\n== mutazione: {name}, la suite deve fallire")
        if text.count(old) != 1:
            print("  FAIL la riga da mutare non c'e' piu': la mutazione non proverebbe niente")
            return 1
        caught = run(load(text.replace(old, new)))
        print(f"  -> mutante {'preso' if caught else 'NON preso'} ({caught} rossi)")
        missed += not caught
    print(f"\n{'verde' if not fails else f'{fails} falliti'}; "
          f"{'mutanti presi' if not missed else f'{missed} mutanti NON presi'}")
    return 0 if not fails and not missed else 1


if __name__ == "__main__":
    sys.exit(main())
