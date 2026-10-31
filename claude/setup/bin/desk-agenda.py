#!/usr/bin/env python3
"""Agenda di oggi e domani per il widget Promemoria.

Legge i tre calendari con gws-mail (sola lettura) e scrive ~/.topics/reminders-desk/agenda.json in modo
atomico: il widget non legge mai un file a metà. Tiene una cache per account: se un calendario non risponde,
usa l'ultima lettura buona e lo segnala in "failed". Lo lancia il job com.jarvis.reminders-agenda ogni 15 minuti.
"""
import json
import os
import subprocess
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

ROME = ZoneInfo("Europe/Rome")
GWS = "/opt/homebrew/bin/gws-mail"
DESK = os.path.expanduser("~/.topics/reminders-desk")
OUT = os.path.join(DESK, "agenda.json")
CACHE = os.path.join(DESK, "agenda.cache.json")
# Sigla nel widget: P personale, A Armonia, C consulenza. Sono gli account di gws-mail.
ACCOUNTS = [("zorahrel", "P"), ("armonia", "A"), ("guedado", "C")]
STALE_MINUTES = 60


def parse_iso(value):
    # Python 3.9 non accetta la Z finale: la trasformo in +00:00.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def fetch(account):
    """Eventi di oggi e dei due giorni successivi, come li dà gws-mail. Solleva eccezione se non risponde."""
    out = subprocess.run(
        [GWS, account, "calendar", "+agenda", "--days", "2", "--format", "json"],
        capture_output=True, text=True, timeout=90,
    )
    start = out.stdout.find("{")  # il banner del keyring precede il JSON
    if out.returncode != 0 or start < 0:
        raise RuntimeError(f"gws-mail exit {out.returncode}")
    events = json.loads(out.stdout[start:]).get("events", [])
    return [
        {"start": e.get("start") or "", "end": e.get("end") or "",
         "title": (e.get("summary") or "(senza titolo)").strip()}
        for e in events
    ]


def in_window(ev, tag, today, tomorrow, now):
    """La riga per il widget se l'evento tocca oggi o domani e non è ancora finito, altrimenti None."""
    start = ev["start"]
    if "T" not in start:  # tutto il giorno: solo date, fine esclusiva
        first = date.fromisoformat(start)
        last = date.fromisoformat(ev["end"]) if ev["end"] else first + timedelta(days=1)
        if last <= today or first > tomorrow:
            return None
        return {"acct": tag, "day": max(first, today).isoformat(), "time": "", "allDay": True, "title": ev["title"]}
    s = parse_iso(start).astimezone(ROME)
    e = parse_iso(ev["end"]).astimezone(ROME) if ev["end"] else s
    if s.date() not in (today, tomorrow) or e < now:
        return None
    return {"acct": tag, "day": s.date().isoformat(), "time": s.strftime("%H:%M"), "allDay": False, "title": ev["title"]}


def main():
    now = datetime.now(ROME)
    today = now.date()
    tomorrow = today + timedelta(days=1)
    cache = load(CACHE, {})
    failed = []
    for account, tag in ACCOUNTS:
        try:
            cache[tag] = {"fetched": now.isoformat(timespec="seconds"), "events": fetch(account)}
        except Exception as e:  # un calendario guasto non ferma gli altri
            failed.append({"acct": tag, "error": type(e).__name__})
    save_atomic(CACHE, cache)

    rows, stale = [], {}
    for _, tag in ACCOUNTS:
        entry = cache.get(tag)
        if not entry:
            continue
        rows += [r for r in (in_window(ev, tag, today, tomorrow, now) for ev in entry["events"]) if r]
        if (now - parse_iso(entry["fetched"])).total_seconds() > STALE_MINUTES * 60:
            stale[tag] = entry["fetched"]
    rows.sort(key=lambda r: (r["day"], not r["allDay"], r["time"], r["title"]))
    save_atomic(OUT, {"updated": now.isoformat(timespec="seconds"), "events": rows, "failed": failed, "stale": stale})


if __name__ == "__main__":
    main()
