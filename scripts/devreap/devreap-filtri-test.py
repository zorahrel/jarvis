#!/usr/bin/env python3
"""Suite della regola «filtri git orfani» di devreap, con una tabella ps finta.

Chiude solo un `git-crypt clean|smudge` con ppid 1 e del nostro utente: quello con il suo git
vivo, di un altro utente o un comando git-crypt qualunque restano, e main la chiama a ogni giro,
prima del gate di pressione. In fondo le mutazioni: tolto il ppid 1 il filtro di un git vivo
verrebbe chiuso; tolta la chiamata in main la regola non girerebbe mai. La suite deve fallire.

    python3 -I devreap-filtri-test.py        exit 0 = verde e mutazione vista
"""
import importlib.machinery
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

SRC = Path(__file__).resolve().parent / "devreap"
MUTATIONS = [
    ("tolto il ppid 1", 'if i["ppid"] == 1 and i["uid"] == uid', 'if i["uid"] == uid'),
    # 25/10, verifica: senza la chiamata in main la suite restava verde, la copriva solo il giro vero
    ("tolta la chiamata in main", "    reap_git_filters(procs, dry)\n", "    pass\n"),
]
RAW = b"""\
    1     0     0   0.0 9-01:00:00 Fri Oct 16 10:00:00 2026 /sbin/launchd
  200     1   501   0.0 1-11:52:04 Sat Oct 24 03:02:56 2026 git-crypt clean
  202     1   501   0.0    05:00 Sun Oct 25 14:50:00 2026 /opt/homebrew/bin/git-crypt smudge
  300  9000   501   0.0    00:20 Sun Oct 25 14:54:40 2026 git status --porcelain=v2
  201   300   501   0.0    00:19 Sun Oct 25 14:54:41 2026 git-crypt clean
  203     1     0   0.0    09:00 Sun Oct 25 14:46:00 2026 git-crypt clean
  204     1   501   0.0    09:00 Sun Oct 25 14:46:00 2026 git-crypt status
  205     1   501   0.0    09:00 Sun Oct 25 14:46:00 2026 vim appunti-git-crypt clean
"""


def load(text=None):
    os.environ.pop("DEVREAP_ONLY_PATH", None)        # il recinto qui non serve
    loader = importlib.machinery.SourceFileLoader("devreap_ft", str(SRC))
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("devreap_ft", loader))
    if text is None:
        loader.exec_module(mod)
    else:
        exec(compile(text, str(SRC), "exec"), mod.__dict__)
    return mod


def run(mod):
    fails = 0

    def check(cond, msg):
        nonlocal fails
        print(f"  {'ok  ' if cond else 'FAIL'} {msg}")
        fails += not cond

    procs = mod.ps_table(RAW)
    got = mod.git_filter_orphans(procs, 501)
    check(got == [200, 202], f"prende solo i filtri orfani del nostro utente: {got}")
    check(201 not in got, "il filtro di un git vivo resta")

    # Il giro vero, con kill e log finti: un TERM per orfano e una riga di log ciascuno.
    killed, lines = [], []
    mod.kill_tree = lambda pids, dry=False, grace=6: killed.extend(pids) or "TERM"
    mod.log = lambda msg, echo=False: lines.append(msg)
    mod.LiveProbe = lambda: type("P", (), {"cwd": lambda self, p: "/Users/x/.claude/jarvis/private"})()
    mod.os.getuid = lambda: 501
    mod.reap_git_filters(procs, dry=False)
    check(killed == [200, 202], f"il TERM va solo agli orfani: {killed}")
    check(len(lines) == 2 and all(l.startswith("REAP-FILTRO") and "cwd=/Users/x/.claude/jarvis/private" in l
                                  for l in lines), "una riga REAP-FILTRO per orfano, con la cwd")
    killed.clear(); lines.clear()
    mod.reap_git_filters(procs, dry=False, listing=True)
    check(not killed and not lines, "--list non chiude niente")

    # main: la regola gira a ogni giro, anche col Mac che respira (il gate esce prima del resto)
    killed.clear(); lines.clear()
    mod.ps_table = lambda raw=None: procs
    mod.swap_pct = lambda: 0.0
    mod.Owners = lambda procs: None
    mod.reap_scratch = lambda *a, **k: set()
    mod.reap_resto = lambda *a, **k: None
    mod.survey = lambda procs: []
    argv = sys.argv
    with tempfile.TemporaryDirectory() as tmp:
        mod.STATE = Path(tmp) / "state.json"
        sys.argv = ["devreap"]
        try:
            mod.main()
        finally:
            sys.argv = argv
    check(killed == [200, 202], f"main chiude gli orfani prima del gate, col Mac che respira: {killed}")
    return fails


def main():
    print("== filtri git orfani: la suite sul codice vero")
    real = os.getuid
    fails = run(load())
    os.getuid = real
    text, missed = SRC.read_text(), 0
    for name, old, new in MUTATIONS:
        print(f"\n== mutazione: {name}, la suite deve fallire")
        if text.count(old) != 1:
            print("  FAIL la riga da mutare non c'e' piu': la mutazione non proverebbe niente")
            return 1
        caught = run(load(text.replace(old, new)))
        os.getuid = real
        print(f"  -> mutante {'preso' if caught else 'NON preso'} ({caught} rossi)")
        missed += not caught
    print(f"\n{'verde' if not fails else f'{fails} falliti'}; "
          f"{'mutanti presi' if not missed else f'{missed} mutanti NON presi'}")
    return 0 if not fails and not missed else 1


if __name__ == "__main__":
    sys.exit(main())
