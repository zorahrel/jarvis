#!/usr/bin/env python3
"""Quote d'uso per il widget Quote. Solo lettura.

Legge il server locale delle quote (claude-usage-tray, 127.0.0.1:3337) e tiene SOLO percentuali, scadenze e stato per account.
Importi, email, etichette degli account e dettagli di spesa NON passano: sul desktop finiscono negli screenshot.
Stampa due righe: l'epoch di adesso, poi un JSON {accounts: [...]} oppure {error: ...}.
"""
import json
import time
import urllib.request

URL = "http://127.0.0.1:3337/api/overview"


def main():
    out = {"accounts": []}
    try:
        with urllib.request.urlopen(URL, timeout=4) as r:
            data = json.load(r)
        for provider in data.get("providers", []):
            for acc in provider.get("accounts", []):
                quotas = [
                    {"key": q.get("key"), "usedPct": q.get("usedPct"), "resetsAt": q.get("resetsAt"), "status": q.get("status")}
                    for q in (acc.get("quotas") or [])
                    if isinstance(q, dict)
                ]
                out["accounts"].append({
                    "provider": provider.get("name") or provider.get("id"),
                    "code": acc.get("code"),
                    "active": bool(acc.get("active")),
                    "status": acc.get("status"),
                    "quotas": quotas,
                })
    except Exception as e:  # server spento, risposta strana: il widget lo dice, non si inventa niente
        out = {"error": type(e).__name__}
    print(int(time.time()))
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
