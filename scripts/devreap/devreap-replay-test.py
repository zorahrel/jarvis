#!/usr/bin/env python3
"""Replay delle osservazioni «si chiuderebbe» del log di devreap (27-31/10), prima di accendere
la chiusura dei resti (DEVREAP_RESTO_KILL=1).

Il fixture `fixtures/resto-log-27-31-10.tsv` sono le righe OSSERVO-RESTO del log, una per processo
(pid, motivo, cwd, comando troncato a 120 caratteri). Per ognuna il verdetto atteso e' scritto a mano:
le cinque che non devono morire (tunnel ssh staccato apposta, demone di 1Password, hub di Jarvis,
database) sono escluse dalla regola; le altre venti sono server, vite e deno dimenticati che la
regola puo' chiudere. Il test vale solo sul gate delle esclusioni (RESTO_ESCLUSI): il padrone morto
era gia' stato verificato dal log.

Mutazioni: tolta ciascuna esclusione, la suite deve fallire.

    python3 -I devreap-replay-test.py      exit 0 = verde e mutanti visti
"""
import importlib.machinery
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "devreap"
FIXTURE = HERE / "fixtures" / "resto-log-27-31-10.tsv"

# Pid che devono restare vivi: escluse dalla regola, staccate apposta.
ESCLUSI = {
    "50245": "tunnel ssh -f -N",
    "6888": "demone di 1Password",
    "48117": "hub di Jarvis",
    "99784": "server di database (mysqld con dati di staging)",
    "40973": "server di database (postgres in /tmp)",
}
# Mutazioni: ognuna toglie un'esclusione (tutti i suoi punti di guardia). La suite deve vedere il pid che morirebbe.
MUTATIONS = [
    ("tolta l'esclusione dell'hub di Jarvis (cwd e comando)", [
        ('re.compile(r"(?:^|/)tools/usage-hub(?:/|$)")', 're.compile(r"(?!x)x")'),
        ('re.compile(r"tools/usage-hub/|usage-hub\\.mjs")', 're.compile(r"(?!x)x")'),
    ]),
    ("tolta l'esclusione dei database", [
        ('re.compile(r"(?:^|/)(?:mysqld|postgres|mongod|redis-server)(?:\\s|$)")', 're.compile(r"(?!x)x")'),
    ]),
    ("tolto il tunnel ssh -f (resta solo -N)", [
        ("[A-Za-z]*[fN][A-Za-z]*", "[A-Za-z]*N[A-Za-z]*"),
    ]),
]
# Casi fuori dal log, dove il tunnel e' ssh -f senza -N: il log non ne ha, ma la regola deve coprirli.
EXTRA = [
    ("ssh -f host comando", "/Users/zorahrel/Projects/x", True),
    ("ssh -o ServerAliveInterval=30 host", "/Users/zorahrel/Projects/x", False),
]


def load(text=None):
    os.environ.pop("DEVREAP_ONLY_PATH", None)
    loader = importlib.machinery.SourceFileLoader("devreap_replay", str(SRC))
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("devreap_replay", loader))
    if text is None:
        loader.exec_module(mod)
    else:
        exec(compile(text, str(SRC), "exec"), mod.__dict__)
    return mod


def rows():
    out = []
    for line in FIXTURE.read_text().splitlines():
        pid, motivo, cwd, cmd = line.split("\t")
        out.append((pid, motivo, cwd, cmd))
    return out


def run(mod, quiet=False):
    fails, closed = 0, []

    def check(cond, msg):
        nonlocal fails
        if not quiet:
            print(f"  {'ok  ' if cond else 'FAIL'} {msg}")
        fails += not cond

    data = rows()
    check(len(data) == 25, f"il fixture ha 25 processi unici dal log: {len(data)}")
    for pid, motivo, cwd, cmd in data:
        why = mod.resto_escluso(cmd, cwd)
        if why is None:
            closed.append(pid)
        if pid in ESCLUSI:
            check(why is not None, f"pid {pid} ({ESCLUSI[pid]}) escluso: {why}")
        else:
            check(why is None, f"pid {pid} non escluso, la regola lo puo' chiudere: {cmd[:50]}")
    check(len(closed) == 20, f"le chiudibili sono 20: {len(closed)}")
    for cmd, cwd, atteso in EXTRA:
        check((mod.resto_escluso(cmd, cwd) is not None) == atteso, f"«{cmd}» escluso={atteso}")
    return fails


def main():
    print("== replay delle osservazioni 27-31/10: esclusioni sul codice vero")
    fails = run(load())
    text, missed = SRC.read_text(), 0
    for name, swaps in MUTATIONS:
        print(f"\n== mutazione: {name}, la suite deve fallire")
        mutated = text
        for old, new in swaps:
            if mutated.count(old) != 1:
                print("  FAIL la riga da mutare non c'e' piu': la mutazione non proverebbe niente")
                return 1
            mutated = mutated.replace(old, new)
        caught = run(load(mutated), quiet=True)
        print(f"  -> mutante {'preso' if caught else 'NON preso'} ({caught} rossi)")
        missed += not caught
    print(f"\n{'verde' if not fails else f'{fails} falliti'}; "
          f"{'mutanti presi' if not missed else f'{missed} mutanti NON presi'}")
    return 0 if not fails and not missed else 1


if __name__ == "__main__":
    sys.exit(main())
