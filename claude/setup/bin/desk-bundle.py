#!/usr/bin/env python3
"""Dati per il widget Promemoria. Solo lettura: non scrive niente.

Stampa due righe: l'epoch di scrittura di all.json (serve al segnale «job fermo»), poi un oggetto JSON
con promemoria, agenda e cosa aspetta Attilio. Una fonte che manca diventa null, con il motivo in "errors".
"""
import glob
import json
import os
import sqlite3
import sys

HOME = os.path.expanduser("~")
DESK = os.path.join(HOME, ".topics", "reminders-desk")
TOPICS_DB = os.path.join(HOME, "Projects", "topics-app", "data", "topics.db")
SESSIONS = os.path.join(HOME, ".claude", "sessions")
errors = []


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        errors.append(f"{os.path.basename(path)}: {type(e).__name__}")
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def sessions_waiting():
    """Sessioni Claude vive in stato 'waiting': aspettano una risposta di Attilio."""
    found = []
    for path in glob.glob(os.path.join(SESSIONS, "*.json")):
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            pid = int(d.get("pid") or os.path.basename(path).split(".")[0])
        except (OSError, ValueError):
            continue
        if d.get("status") != "waiting" or not alive(pid):
            continue
        # Il testo di ciò che la sessione chiede NON si porta sul desktop: può contenere nomi, importi, comandi.
        found.append({
            "project": os.path.basename((d.get("cwd") or "").rstrip("/")) or "sessione",
            "since": int(d.get("statusUpdatedAt") or 0) // 1000,
        })
    return sorted(found, key=lambda s: s["since"])


def cards_in_review():
    """Card della board Topics ferme in review: le approva Attilio."""
    if not os.path.exists(TOPICS_DB):
        errors.append("topics.db: assente")
        return None
    try:
        con = sqlite3.connect(f"file:{TOPICS_DB}?mode=ro", uri=True, timeout=2)
        try:
            count = con.execute(
                "select count(*) from tasks where status='review' and coalesce(archived,0)=0"
            ).fetchone()[0]
            rows = con.execute(
                "select t.text, p.name from tasks t left join projects p on p.id = t.project_id "
                "where t.status='review' and coalesce(t.archived,0)=0 order by t.updated_at desc limit 5"
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error as e:
        errors.append(f"topics.db: {type(e).__name__}")
        return None
    return {"count": count, "cards": [{"title": t or "", "project": p or ""} for t, p in rows]}


def list_names():
    """Tutte le liste di Promemoria, anche quelle senza promemoria (nei promemoria non compaiono). Le scrive reminders_act.py."""
    path = os.path.join(DESK, "lists.json")
    if not os.path.exists(path):
        return []
    data = load(path)
    return [x["title"] for x in data if isinstance(x, dict) and x.get("title")] if isinstance(data, list) else []


def main():
    # Senza argomenti legge tutto; con nomi (reminders, agenda, waiting) solo quelle fonti: un widget non paga ciò che non mostra.
    want = set(sys.argv[1:]) or {"reminders", "agenda", "waiting"}
    all_path = os.path.join(DESK, "all.json")
    epoch = int(os.path.getmtime(all_path)) if os.path.exists(all_path) else 0
    bundle = {
        "reminders": load(all_path) if "reminders" in want else None,
        "lists": list_names() if "reminders" in want else None,
        "agenda": load(os.path.join(DESK, "agenda.json")) if "agenda" in want else None,
        "waiting": {"sessions": sessions_waiting(), "review": cards_in_review()} if "waiting" in want else None,
        "errors": errors,
    }
    print(epoch)
    print(json.dumps(bundle, ensure_ascii=False))


if __name__ == "__main__":
    main()
