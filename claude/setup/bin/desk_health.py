#!/usr/bin/env python3
"""Stato dei servizi e dei job del desk, per il widget Servizi. Solo lettura: non avvia e non ferma niente.

Stampa due righe: l'epoch di adesso, poi un JSON con
  services  i servizi sempre accesi (LaunchAgent com.jarvis.* e com.armonia.* con KeepAlive true): pid, ultimo codice di uscita
  desk      i tre job del desk: lettura promemoria, agenda, coda delle azioni
"""
import glob
import json
import os
import plistlib
import re
import subprocess
import time
from datetime import datetime

HOME = os.path.expanduser("~")
AGENTS = os.path.join(HOME, "Library", "LaunchAgents")
DESK = os.path.join(HOME, ".topics", "reminders-desk")
PREFIXES = ("com.jarvis.", "com.armonia.")
DAY = 24 * 3600


def launchd():
    out = subprocess.run(["/bin/launchctl", "list"], capture_output=True, text=True, timeout=10).stdout
    state = {}
    for line in out.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        pid, status, label = parts
        state[label] = {
            "pid": int(pid) if pid.isdigit() else None,
            "exit": int(status) if re.fullmatch(r"-?\d+", status) else None,
        }
    return state


def disabled_labels():
    """Servizi che launchd ha disabilitato esplicitamente (launchctl disable): spenti di proposito, non guasti."""
    out = subprocess.run(["/bin/launchctl", "print-disabled", "gui/%d" % os.getuid()], capture_output=True, text=True, timeout=10).stdout
    return set(re.findall(r'"([^"]+)"\s*=>\s*(?:disabled|true)', out))


def services(state):
    off = disabled_labels()
    found = []
    for path in sorted(glob.glob(os.path.join(AGENTS, "*.plist"))):
        label = os.path.basename(path)[: -len(".plist")]
        if not label.startswith(PREFIXES):
            continue
        try:
            with open(path, "rb") as f:
                plist = plistlib.load(f)
        except Exception:
            continue
        if plist.get("KeepAlive") is not True:  # i periodici e quelli «riparti solo se falliscono» non sono servizi sempre accesi
            continue
        st = state.get(label)
        found.append({
            "name": label.split(".", 2)[2],
            "label": label,
            "loaded": st is not None,
            "pid": st["pid"] if st else None,
            "exit": st["exit"] if st else None,
            "disabled": label in off,
        })
    return found


def age(path):
    try:
        return max(0, int(time.time() - os.path.getmtime(path)))
    except OSError:
        return None


def agenda_failed():
    try:
        with open(os.path.join(DESK, "agenda.json"), encoding="utf-8") as f:
            return [x.get("acct") for x in json.load(f).get("failed", []) if x.get("acct")]
    except (OSError, ValueError, AttributeError):
        return []


def recent_files(pattern):
    n = 0
    for p in glob.glob(pattern):
        try:
            if time.time() - os.path.getmtime(p) < DAY:
                n += 1
        except OSError:
            pass
    return n


def last_error():
    """Il motivo dell'ultimo errore della coda nelle ultime 24 ore, senza titoli né id."""
    try:
        with open(os.path.join(DESK, "actions.log"), encoding="utf-8") as f:
            lines = f.readlines()[-300:]
    except OSError:
        return ""
    for line in reversed(lines):
        if " ERRORE " not in line:
            continue
        try:
            when = datetime.strptime(line[:19], "%Y-%m-%d %H:%M:%S").timestamp()
        except ValueError:
            return ""
        return line[20:].strip().split(": ", 1)[-1][:80] if time.time() - when < DAY else ""
    return ""


def main():
    state = launchd()
    desk = {
        "read": {"loaded": "com.jarvis.reminders-desk" in state, "ageSec": age(os.path.join(DESK, "all.json"))},
        "agenda": {
            "loaded": "com.jarvis.reminders-agenda" in state,
            "ageSec": age(os.path.join(DESK, "agenda.json")),
            "failed": agenda_failed(),
        },
        "repos": {"loaded": "com.jarvis.desk-repos" in state, "ageSec": age(os.path.join(DESK, "repos.json"))},
        "act": {
            "loaded": "com.jarvis.reminders-act" in state,
            "queue": len(glob.glob(os.path.join(DESK, "queue", "*.json"))),
            "failed": recent_files(os.path.join(DESK, "queue", "failed", "*.json")),
            "lastError": last_error(),
        },
    }
    print(int(time.time()))
    print(json.dumps({"services": services(state), "desk": desk}, ensure_ascii=False))


if __name__ == "__main__":
    main()
