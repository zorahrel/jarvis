#!/usr/bin/env python3
"""Avvolge un passo Lobster e scrive una riga in runs.jsonl (inizio, passo, esito).
Uso: runlog.py <workflow> <passo> [--first] [--last] -- <comando shell>
Propaga stdout ed exit code del comando. Il giro nuovo nasce col passo --first."""
import json, os, subprocess, sys, time, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "runs.jsonl")
a = sys.argv[1:]; i = a.index("--"); wf, step, flags, cmd = a[0], a[1], a[2:i], " ".join(a[i+1:])
idf = os.path.expanduser(f"~/.lobster/runid-{wf}")
if "--first" in flags or not os.path.exists(idf):
    open(idf, "w").write(uuid.uuid4().hex[:8])
run = open(idf).read().strip()
def log(status):
    with open(LOG, "a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "run": run, "workflow": wf, "step": step, "status": status}) + "\n")
log("running")
rc = subprocess.call(cmd, shell=True)
log("failed" if rc else ("done" if "--last" in flags else "step-ok"))
sys.exit(rc)
