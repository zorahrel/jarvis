#!/usr/bin/env python3
"""Stato git dei progetti per il widget Repo: lavoro non salvato (file modificati o nuovi) e commit non pubblicati.

Uso:  desk_repos.py --scan   scansiona ~/Projects e scrive repos.json (lo lancia il job com.jarvis.desk-repos)
      desk_repos.py --read   stampa l'epoch di scrittura e il contenuto (lo lancia il widget)

Sui repository si legge e basta: `git --no-optional-locks` non prende lock e non riscrive l'indice, quindi non disturba chi ci sta
lavorando in quel momento (altre sessioni, un commit in corso). Nomi di progetto e conteggi: nessun contenuto dei file.
«Da pubblicare» = commit raggiungibili da HEAD ma da nessun remoto. Senza remoti non si dice «da pubblicare» (sarebbe tutta la storia):
si segna «senza remoto». Un repository che git non riesce a leggere (worktree orfano, indice rotto) NON risulta pulito:
finisce in `errors` e in `unreadable`, e il widget lo dice.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
# DESK_REPOS_ROOT e DESK_REPOS_OUT servono solo alle prove: il job non li imposta.
ROOT = os.environ.get("DESK_REPOS_ROOT") or os.path.join(HOME, "Projects")
OUT = os.environ.get("DESK_REPOS_OUT") or os.path.join(HOME, ".topics", "reminders-desk", "repos.json")
GIT = "/usr/bin/git"
WORKERS = 6
ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}


def git(path, *args):
    p = subprocess.run([GIT, "--no-optional-locks", "-C", path, *args], capture_output=True, text=True, timeout=25, env=ENV)
    return p.returncode, p.stdout


def must(path, *args):
    code, out = git(path, *args)
    if code != 0:
        raise RuntimeError("git %s: uscita %d" % (args[0], code))
    return out


def probe(name):
    path = os.path.join(ROOT, name)
    try:
        lines = must(path, "status", "--porcelain=v1", "-unormal").splitlines()
        remotes = must(path, "remote").split()
        # Un repository appena creato non ha ancora commit: non è un errore, semplicemente non c'è niente da pubblicare.
        has_commits = git(path, "rev-parse", "--verify", "-q", "HEAD")[0] == 0
        ahead, last = 0, 0
        if has_commits:
            if remotes:
                ahead = int(must(path, "rev-list", "--count", "HEAD", "--not", "--remotes").strip() or 0)
            last = int(must(path, "log", "-1", "--format=%ct").strip() or 0)
        touched = last
        for line in lines[:40]:  # quando ho toccato per l'ultima volta il lavoro non salvato
            rel = line[3:].split(" -> ")[-1].strip('"')
            try:
                touched = max(touched, int(os.path.getmtime(os.path.join(path, rel))))
            except OSError:
                pass
        return {
            "name": name,
            "branch": must(path, "branch", "--show-current").strip() or "(detached)",
            "changed": sum(1 for x in lines if not x.startswith("??")),
            "untracked": sum(1 for x in lines if x.startswith("??")),
            "ahead": ahead,
            "noRemote": not remotes,
            "worktree": os.path.isfile(os.path.join(path, ".git")),
            "lastCommit": last,
            "touched": touched,
        }
    except Exception:
        return {"name": name, "error": True}


def scan():
    names = sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, ".git")))
    t0 = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        rows = list(pool.map(probe, names))
    data = {
        "scannedAt": int(time.time()),
        "scanSec": round(time.time() - t0, 1),
        "total": len(names),
        "errors": sum(1 for r in rows if r.get("error")),
        "unreadable": [r["name"] for r in rows if r.get("error")][:6],
        "repos": [r for r in rows if not r.get("error")],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=os.path.basename(OUT) + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, OUT)  # il widget non vede mai un file a metà


def read():
    try:
        print(int(os.path.getmtime(OUT)))
        with open(OUT, encoding="utf-8") as f:
            print(f.read())
    except OSError:
        print(0)
        print(json.dumps({"error": "nessuna scansione"}))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "--scan":
        scan()
    elif mode == "--read":
        read()
    else:
        print(__doc__)
        sys.exit(2)
