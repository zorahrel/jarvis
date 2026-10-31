#!/usr/bin/env python3
# Esegue la coda del widget Promemoria. Gira come job launchd (com.jarvis.reminders-act), così il permesso
# di Promemoria resta a lui e non a Übersicht. Ogni richiesta è un file JSON in queue/.
# Azioni ammesse: add, complete, reopen, prio, list, due, rename. Eliminare non è previsto da nessuna parte.
# Con --refresh non esegue la coda: riscrive solo i dati. Lo lancia anche il job di lettura (com.jarvis.reminders-desk),
# così all.json lo scrive un codice solo.
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

HOME = os.path.expanduser("~")
# REMINDERS_DESK_DIR e REMINDCTL servono solo alle prove (cartella e remindctl finti): il job non li imposta.
BASE = os.environ.get("REMINDERS_DESK_DIR") or os.path.join(HOME, ".topics", "reminders-desk")
QUEUE = os.path.join(BASE, "queue")
FAILED = os.path.join(QUEUE, "failed")
DATA = os.path.join(BASE, "all.json")
LISTS = os.path.join(BASE, "lists.json")
LOG = os.path.join(BASE, "actions.log")
RC = os.environ.get("REMINDCTL") or "/opt/homebrew/bin/remindctl"
ROME = ZoneInfo("Europe/Rome")
PRIORITIES = {"none", "low", "medium", "high"}
DUES = {"none", "today", "tomorrow", "week"}
ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
# Solo UUID veri: un id come «00000001» sarebbe letto da remindctl come l'indice 1 (un altro promemoria),
# e uno che comincia con «-» come un'opzione.
ID_RE = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")


def rc(args):
    p = subprocess.run([RC] + args, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr


def log(line):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line + "\n")


def checked_id(req):
    rid = req.get("id") or ""
    if not isinstance(rid, str) or not ID_RE.fullmatch(rid):
        raise ValueError("id non valido")
    return rid


def checked_title(value):
    title = (value or "").strip()
    if not title or title.startswith("-"):
        raise ValueError("titolo vuoto o non valido")
    return title


def known_lists():
    # Le liste che esistono: quelle dei promemoria letti e quelle di lists.json, comprese le vuote
    # (nei promemoria una lista senza promemoria non compare).
    names = set()
    for path, key in ((DATA, "listName"), (LISTS, "title")):
        try:
            with open(path, encoding="utf-8") as f:
                names |= {x.get(key) for x in json.load(f) if isinstance(x, dict)}
        except (OSError, ValueError):
            pass
    names.discard(None)
    return names


def checked_list(name):
    # Solo liste che esistono già: un nome sbagliato non crea liste nuove.
    if not isinstance(name, str) or not name or name.startswith("-") or name not in known_lists():
        raise ValueError("lista non valida")
    return name


def valid_due(due):
    # Le scelte fisse, oppure una data ISO vera (per «Altra data…» e per @15/10 nel titolo).
    if due in DUES:
        return True
    if isinstance(due, str) and ISO_RE.fullmatch(due):
        try:
            datetime.strptime(due, "%Y-%m-%d")
            return True
        except ValueError:
            return False
    return False


def due_value(due):
    # Valore per --due di remindctl. None vuol dire nessuna scadenza.
    if due in ("today", "tomorrow"):
        return due
    if isinstance(due, str) and ISO_RE.fullmatch(due):
        return due
    if due == "week":
        return (datetime.now(ROME) + timedelta(days=7)).date().isoformat()
    return None


def build(req):
    op = req.get("op")
    if op == "complete":
        return ["edit", checked_id(req), "--complete"]
    if op == "reopen":
        return ["edit", checked_id(req), "--incomplete"]
    if op == "prio":
        if req.get("to") not in PRIORITIES:
            raise ValueError("priorità non valida")
        return ["edit", checked_id(req), "--priority", req["to"]]
    if op == "list":
        return ["edit", checked_id(req), "--list", checked_list(req.get("to"))]
    if op == "due":
        if not valid_due(req.get("to")):
            raise ValueError("scadenza non valida")
        value = due_value(req["to"])
        if value:
            return ["edit", checked_id(req), "--due", value]
        return ["edit", checked_id(req), "--clear-due"]
    if op == "rename":
        return ["edit", checked_id(req), "--title", checked_title(req.get("title"))]
    if op == "add":
        title = checked_title(req.get("title"))
        lst = checked_list(req.get("list"))
        prio = req.get("priority") or "none"
        due = req.get("due") or "none"
        if prio not in PRIORITIES or not valid_due(due):
            raise ValueError("scadenza o priorità non valide")
        args = ["add", title, "--list", lst, "--priority", prio]
        value = due_value(due)
        if value:
            args += ["--due", value]
        return args
    raise ValueError("azione non ammessa")


def process(path):
    name = os.path.basename(path)
    try:
        with open(path, encoding="utf-8") as f:
            req = json.load(f)
        code, out, err = rc(build(req))
        label = "%s %s" % (req.get("op"), (req.get("id") or "")[:8])
    except Exception as e:  # richiesta rotta: si mette da parte, senza riprovare in loop
        code, out, err, label = 1, "", str(e), "richiesta rotta"
    if code == 0:
        os.remove(path)
        log("OK %s (%s)" % (label, name))
    else:
        os.makedirs(FAILED, exist_ok=True)
        os.replace(path, os.path.join(FAILED, name))
        log("ERRORE %s (%s): %s" % (label, name, (err or out).strip()[:200]))


def write_atomic(path, text):
    # File temporaneo dal nome UNICO nella stessa cartella, poi rename: due scrittori contemporanei non si pestano
    # (con un nome fisso si troncavano a vicenda) e chi legge non vede mai un file a metà.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def refresh():
    for args, path in ((["show", "all", "--json"], DATA), (["list", "--json"], LISTS)):
        try:
            code, out, err = rc(args)
        except (OSError, subprocess.SubprocessError) as e:  # remindctl non parte o non risponde: i dati buoni restano
            log("refresh fallito (%s): %s" % (args[0], type(e).__name__))
            continue
        if code != 0:
            log("refresh fallito (%s): %s" % (args[0], err.strip()[:200]))
            continue
        try:
            json.loads(out)  # mai al posto di dati buoni con qualcosa che non è JSON
        except ValueError:
            log("refresh scartato (%s): l'uscita non è JSON" % args[0])
            continue
        write_atomic(path, out)


def main():
    os.makedirs(QUEUE, exist_ok=True)
    if "--refresh" in sys.argv[1:]:
        refresh()
        return
    while True:
        for path in sorted(glob.glob(os.path.join(QUEUE, "*.json"))):
            process(path)
        refresh()
        if not glob.glob(os.path.join(QUEUE, "*.json")):
            break


if __name__ == "__main__":
    main()
