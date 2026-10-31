#!/usr/bin/env python3
"""Probe dei canali di OpenClaw (Discord, Telegram, WhatsApp).

Legge `openclaw channels status --json` su stdin e stampa righe STATO|nome|messaggio.

Perche' esiste: fino al 18/10 questo controllo interrogava il router (/api/whatsapp/status),
che dopo la dismissione non risponde piu': il probe dava FAIL ogni mattina per un servizio
che non c'e' piu'. Ora il canale e' un figlio del gateway e lo stato lo dice lui.
FAIL = canale configurato e acceso ma non connesso; WARN = connesso con un errore aperto
o un problema segnalato da OpenClaw.
"""
import json
import sys


def main() -> int:
    try:
        d = json.load(sys.stdin)
    except Exception as exc:
        print(f"FAIL|canali|stato dei canali non leggibile: {exc}")
        return 0
    for cid, accounts in (d.get("channelAccounts") or {}).items():
        for a in accounts:
            name = f"{cid}/{a.get('accountId', 'default')}"
            if not a.get("enabled", True) or not a.get("configured", True):
                print(f"SKIP|{name}|spento o non configurato")
            elif not (a.get("running") and a.get("connected")):
                print(f"FAIL|{name}|non connesso (lifecycle {a.get('lifecycle')}, errore {a.get('lastError') or 'nessuno'})")
            elif a.get("lastError"):
                print(f"WARN|{name}|connesso ma con un errore aperto: {str(a['lastError'])[:120]}")
            elif a.get("healthState") not in (None, "healthy"):
                print(f"WARN|{name}|stato {a.get('healthState')}")
            else:
                print(f"OK|{name}|connesso")
    for issue in d.get("statusIssues") or []:
        print(f"WARN|openclaw|{str(issue)[:160]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
