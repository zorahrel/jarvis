#!/usr/bin/env python3
"""Tempo schermo di oggi per il widget Tempo, da ActivityWatch (server locale 127.0.0.1:5600). Solo lettura.

Si tengono i nomi delle app e i minuti: mai i titoli delle finestre. «Attivo» = non in pausa (afk) e con una finestra in primo piano.
Stampa due righe: l'epoch dei dati, poi un JSON {activeMin, yesterdayMin, apps: [{app, min}], otherMin} oppure {error: ...}.
yesterdayMin è ieri FINO alla stessa ora di adesso: il confronto è alla pari.

La query pesa (circa 1,8 s di CPU di ActivityWatch ogni volta) e il widget gira su due schermi: il risultato resta in una cache
di TTL secondi, e chi arriva insieme a un'altra copia aspetta il suo risultato invece di rifare la query. Se ActivityWatch non
risponde si mostra l'ultimo dato buono (con il SUO epoch: il widget segnala da sé che è vecchio), non un errore.
"""
import fcntl
import json
import os
import re
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta

HOME = os.path.expanduser("~")
# AW_BASE e DESK_TIME_CACHE servono solo alle prove (server e cartella finti): il widget non li imposta.
BASE = os.environ.get("AW_BASE") or "http://127.0.0.1:5600/api/0"
CACHE = os.environ.get("DESK_TIME_CACHE") or os.path.join(HOME, ".topics", "reminders-desk", "time.cache.json")
LOCK = CACHE + ".lock"
SAFE = re.compile(r"[A-Za-z0-9._-]+")
TOP = 6
TTL = 90  # secondi: sotto il periodo di rinfresco del widget (120), così ogni giro rifà la query una volta sola
STALE_OK = 30 * 60  # oltre mezz'ora senza dati buoni è più onesto dire che ActivityWatch non risponde


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.load(r)


def freshest(buckets, prefix):
    """Fra più host (Mac cambiati nel tempo) il bucket aggiornato per ultimo."""
    found = [(v.get("last_updated") or "", k) for k, v in buckets.items() if k.startswith(prefix)]
    if not found:
        raise LookupError(prefix)
    bucket = max(found)[1]
    if not SAFE.fullmatch(bucket):
        raise ValueError("nome di bucket inatteso")
    return bucket


def compute():
    buckets = get("/buckets/")
    afk, win = freshest(buckets, "aw-watcher-afk_"), freshest(buckets, "aw-watcher-window_")
    now = datetime.now().astimezone()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday = midnight - timedelta(days=1)
    periods = ["%s/%s" % (midnight.isoformat(), now.isoformat()), "%s/%s" % (yesterday.isoformat(), (now - timedelta(days=1)).isoformat())]
    query = [
        'afk = flood(query_bucket("%s"));' % afk,
        'win = flood(query_bucket("%s"));' % win,
        'win = filter_period_intersect(win, filter_keyvals(afk, "status", ["not-afk"]));',
        'apps = sort_by_duration(merge_events_by_keys(win, ["app"]));',
        'RETURN = {"active": sum_durations(win), "apps": apps};',
    ]
    req = urllib.request.Request(BASE + "/query/", data=json.dumps({"timeperiods": periods, "query": query}).encode(),
                                 headers={"Content-Type": "application/json"})
    today, before = json.load(urllib.request.urlopen(req, timeout=25))
    apps = [{"app": e["data"].get("app") or "?", "min": round(e["duration"] / 60, 1)} for e in today["apps"]]
    return {
        "activeMin": round(today["active"] / 60),
        "yesterdayMin": round(before["active"] / 60),
        "apps": apps[:TOP],
        "otherMin": round(sum(a["min"] for a in apps[TOP:])),
    }


def read_cache():
    try:
        with open(CACHE, encoding="utf-8") as f:
            c = json.load(f)
        return int(c["at"]), c["data"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write_cache(at, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(CACHE), prefix=os.path.basename(CACHE) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"at": at, "data": data}, f, ensure_ascii=False)
        os.replace(tmp, CACHE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def emit(epoch, data):
    print(epoch)
    print(json.dumps(data, ensure_ascii=False))


def main():
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(LOCK, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # l'altra copia aspetta qui: quando tocca a lei il risultato c'è già
        cached = read_cache()
        now = int(time.time())
        if cached and 0 <= now - cached[0] < TTL:
            return emit(cached[0], cached[1])
        try:
            data = compute()
        except Exception as e:
            if cached and now - cached[0] < STALE_OK:
                return emit(cached[0], cached[1])
            return emit(now, {"error": type(e).__name__})
        write_cache(now, data)
        emit(now, data)


if __name__ == "__main__":
    main()
