#!/usr/bin/env python3
"""Probe per la quota Muse Code (Muse Spark).

Legge l'access token OAuth del login `muse` dal Keychain e interroga
l'endpoint di key-mint, che riporta `subs_usage` con le finestre 5h e
settimanale. Cache su file da 5 minuti: l'endpoint è rate-limited.
Stampa sempre un JSON con chiave "quotas" su stdout.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

KEY_URL = "https://api.meta.ai/muse-code/key"
CACHE_PATH = "/tmp/usage-muse-subs.json"
CACHE_TTL = 300
# Dopo un fallimento (Keychain che chiede il prompt, rete, rate-limit) non
# riprovare per 15 minuti: ogni tentativo spawnerebbe un popup all'utente.
# Nel frattempo si serve la cache anche se vecchia.
FAIL_PATH = "/tmp/usage-muse-fail"
FAIL_QUIET = 900
# Il token a volte manca per un attimo (09/10: 9 Muse in parallelo, una lettura
# fallita ha congelato la tray su 80% mentre la quota era a 101%): un secondo
# tentativo prima di dichiarare il fallimento.
RETRY_DELAY = 2
# Dal 21/10 il mint risponde spesso senza subs_usage, anche con l'abbonamento
# attivo: senza quota l'hub non aveva righe per Muse e lo frenava del tutto.
# L'ultima lettura buona resta valida finché la sua settimana non si azzera,
# servita col suo istante vero (la tray scrive «dato di Xh fa»). Fuori da /tmp:
# un riavvio non deve cancellarla.
GOOD_PATH = os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                         "claude-usage-tray", "muse-last-usage.json")


def read_token():
    try:
        out = subprocess.run(
            ["security", "find-generic-password",
             "-s", "ai.meta.dev.credentials", "-a", "meta", "-w"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        payload = json.loads(out.stdout.strip())
    except ValueError:
        return None
    token = payload.get("access_token") if isinstance(payload, dict) else None
    return token.strip() if isinstance(token, str) and token.strip() else None


def fetch_subs(token):
    req = urllib.request.Request(
        KEY_URL, data=b"{}",
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/json",
                 "Content-Type": "application/json",
                 "x-api-version": "1.0.0",
                 "User-Agent": "usage-muse-probe/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                return None
            payload = json.load(resp)
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def load_cached():
    try:
        with open(CACHE_PATH) as f:
            cached = json.load(f)
        if time.time() - cached.get("at", 0) < CACHE_TTL:
            return cached.get("payload"), cached.get("at")
    except (OSError, ValueError):
        pass
    return None, None


# Solo i campi che servono: la risposta del mint contiene anche la chiave API di Muse e /tmp
# è leggibile da tutti gli utenti del Mac (22/10: la chiave stava lì in chiaro, file 644).
KEEP = ("subs_usage", "user_email", "is_subs_active", "subs_tier_name")


def save_cache(payload):
    try:
        slim = {k: payload.get(k) for k in KEEP if k in payload} if isinstance(payload, dict) else payload
        fd = os.open(CACHE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)   # un file già esistente tiene i permessi vecchi senza questo
        with os.fdopen(fd, "w") as f:
            json.dump({"at": time.time(), "payload": slim}, f)
    except OSError:
        pass


def load_stale():
    try:
        with open(CACHE_PATH) as f:
            cached = json.load(f)
        payload = cached.get("payload")
        if isinstance(payload, dict) and payload:
            return payload, cached.get("at")
    except (OSError, ValueError):
        pass
    return None, None


def save_good(usage, at):
    try:
        os.makedirs(os.path.dirname(GOOD_PATH), exist_ok=True)
        with open(GOOD_PATH, "w") as f:
            json.dump({"at": at, "subs_usage": usage}, f)
    except OSError:
        pass


def load_good(now):
    """L'ultima subs_usage letta, senza le finestre già azzerate."""
    try:
        with open(GOOD_PATH) as f:
            good = json.load(f)
    except (OSError, ValueError):
        return None, None
    usage = good.get("subs_usage") if isinstance(good, dict) else None
    if not isinstance(usage, dict):
        return None, None
    live = {k: w for k, w in usage.items()
            if isinstance(w, dict) and float(w.get("resets_at") or 0) > now}
    return (live, good.get("at")) if live else (None, None)


HISTORY_PATH = os.path.join(os.path.dirname(GOOD_PATH), "history.jsonl")
HISTORY_KEY = "|7d"


def last_from_history(email, now, max_age=7 * 86400):
    """Ultimo 7d di Muse dallo storico della tray (solo la coda del file): senza ora
    di reset, ma meglio di una barra vuota. Serve finché il mint non rimanda la quota."""
    try:
        with open(HISTORY_PATH, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 262144))
            tail = f.read().decode("utf-8", "ignore").splitlines()
    except OSError:
        return None, None
    key = f"muse|{email}{HISTORY_KEY}"
    for line in reversed(tail):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        v = (row.get("s") or {}).get(key)
        if isinstance(v, (int, float)) and now - float(row.get("t") or 0) < max_age:
            return {"weekly": {"used_percent": v}}, row.get("t")
    return None, None


def failing_quietly():
    try:
        with open(FAIL_PATH) as f:
            return time.time() - float(f.read().strip() or 0) < FAIL_QUIET
    except (OSError, ValueError):
        return False


def mark_failed():
    try:
        with open(FAIL_PATH, "w") as f:
            f.write(str(time.time()))
    except OSError:
        pass


def clear_failed():
    try:
        os.unlink(FAIL_PATH)
    except OSError:
        pass


def iso(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError, OverflowError):
        return None


def fetch_fresh():
    for attempt in range(2):
        if attempt:
            time.sleep(RETRY_DELAY)
        token = read_token()
        payload = fetch_subs(token) if token else None
        if payload:
            return payload
    return None


def main():
    payload, as_of = load_cached()
    if payload is None:
        if failing_quietly():
            payload, as_of = load_stale()
        else:
            payload = fetch_fresh()
            if payload:
                as_of = time.time()
                save_cache(payload)
                clear_failed()
            else:
                mark_failed()
                payload, as_of = load_stale()
    quotas = []
    usage = (payload or {}).get("subs_usage")
    if isinstance(usage, dict) and usage:
        save_good(usage, as_of)
    elif payload is not None:
        usage, good_at = load_good(time.time())
        if not usage:
            usage, good_at = last_from_history(payload.get("user_email"), time.time())
        if usage:
            as_of = good_at
    if isinstance(usage, dict):
        window = usage.get("window")
        if isinstance(window, dict) and window.get("used_percent") is not None:
            q = {"type": "session",
                 "percentRemaining": max(0.0, min(100.0,
                     100.0 - float(window["used_percent"])))}
            resets = iso(window.get("resets_at"))
            if resets:
                q["resetsAt"] = resets
            quotas.append(q)
        weekly = usage.get("weekly")
        if isinstance(weekly, dict) and weekly.get("used_percent") is not None:
            q = {"type": "weekly",
                 "percentRemaining": max(0.0, min(100.0,
                     100.0 - float(weekly["used_percent"])))}
            resets = iso(weekly.get("resets_at"))
            if resets:
                q["resetsAt"] = resets
            quotas.append(q)
    out = {"quotas": quotas, "email": (payload or {}).get("user_email")}
    # Età del dato: la tray deve poter dire «vecchio», non spacciarlo per attuale.
    if payload and isinstance(as_of, (int, float)):
        out["asOf"] = int(as_of)
    sys.stdout.write(json.dumps(out))



if __name__ == "__main__":
    main()
