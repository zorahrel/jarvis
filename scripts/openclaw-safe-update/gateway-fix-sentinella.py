#!/usr/bin/env python3
"""Sentinella dei fix del gateway OpenClaw, ogni mattina dopo il giro delle 4:20 di openclaw-safe-update.

Sola lettura: il log di openclaw-safe-update e le release di openclaw/openclaw su GitHub.
- se il giro di stanotte e' FALLITO (rollback o «fallito dopo l'update") apre una card sulla board
  (una per notte, board-card --key): niente WhatsApp, Attilio su un update fallito non puo' fare niente (25/10);
- se una release stabile contiene i 3 fix della memoria del gateway (#171354, #174718, #179119, card c4e3df18)
  apre una card per aggiornare, una volta sola.
Rinvii e interruzioni prima dell'attivazione non sono fallimenti: safe-update riprova da solo la notte dopo.
Stampa sempre NO_REPLY. uso: gateway-fix-sentinella.py [--dry-run]  (--dry-run: stampa le card, non le apre)
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

LOG = os.path.expanduser("~/.claude/jarvis/logs/openclaw-safe-update.log")
BOARD_CARD = os.path.expanduser("~/.claude/jarvis/scripts/board-card")
REPO = "openclaw/openclaw"
FIX = ["171354", "174718", "179119"]
FALLITO = re.compile(r"fallito dopo l'update|rollback a ")
DRY = "--dry-run" in sys.argv


def card(key, title, desc):
    if DRY:
        print(f"[dry-run] card {key}: {title}", file=sys.stderr)
        return
    subprocess.run([BOARD_CARD, "--key", key, "--title", title, "--desc", desc], check=True,
                   capture_output=True, text=True, timeout=60)


def gh(path):
    out = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=60)
    return json.loads(out.stdout) if out.returncode == 0 else None


def notte(oggi):
    # righe del giro di stanotte: da ieri alle 22 a oggi alle 9
    da = datetime.combine(oggi - timedelta(days=1), datetime.min.time()).replace(hour=22)
    a = datetime.combine(oggi, datetime.min.time()).replace(hour=9)
    righe = []
    try:
        for r in open(LOG, encoding="utf-8", errors="replace"):
            try:
                t = datetime.strptime(r[:19], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            # «piano:» descrive cosa farebbe safe-update (anche «rollback a …»), non cosa è successo:
            # il 24/10 alle 02:56 una riga così avrebbe aperto una card falsa
            if r[19:].lstrip().startswith("piano:"):
                continue
            if da <= t <= a and "dry-run" not in r:
                righe.append(r.rstrip())
    except OSError as e:
        righe.append(f"(log non leggibile: {e})")
    return righe


def contiene(tag, sha):
    c = gh(f"repos/{REPO}/compare/{sha}...{tag}")
    return bool(c) and c.get("status") in ("ahead", "identical")


def main():
    oggi = datetime.now(ZoneInfo("Europe/Rome")).date()
    righe = notte(oggi)
    if any(FALLITO.search(r) for r in righe):
        card(f"safe-update-fallito-{oggi:%Y%m%d}", f"OpenClaw: l'aggiornamento di stanotte ({oggi:%d/%m}) e' fallito",
             "La sentinella delle 6:50 ha trovato un fallimento nel log di openclaw-safe-update. Dal log capisci "
             "perche', correggi la causa con un test che fallisce sul codice vecchio, poi riprova SOLO con "
             "openclaw-safe-update (mai openclaw update a mano).\n\nRighe di stanotte:\n```\n"
             + "\n".join(righe[-40:]) + "\n```")
    rel = gh(f"repos/{REPO}/releases/latest")
    if rel and rel.get("tag_name"):
        tag = rel["tag_name"]
        shas = [(gh(f"repos/{REPO}/pulls/{n}") or {}).get("merge_commit_sha") for n in FIX]
        if all(shas) and all(contiene(tag, s) for s in shas):
            card(f"gateway-fix-{tag}", f"OpenClaw {tag} porta i 3 fix della memoria del gateway: aggiornare",
                 f"La stabile {tag} contiene #171354, #174718 e #179119 (verificato con compare sui merge commit). "
                 "Aggiornare con openclaw-safe-update (target "
                 f"{tag.lstrip('v')}) e poi misurare la memoria del gateway per 24 ore con oc-memwatch. Card madre: c4e3df18.")
    print("NO_REPLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
