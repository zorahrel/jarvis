#!/usr/bin/env python3
# La mattina dopo un giro di openclaw-safe-update: se OpenClaw e' alla versione attesa non dice niente;
# se no apre una card Topics in coda (board attilio), che un agente lavora. Niente WhatsApp:
# Attilio non puo' fare niente lui su un update fallito (25/10, «ma serve sta roba?»).
# uso: verifica-mattina.py <versione attesa>   (lanciato da un cron OpenClaw one-shot dietro cron-clean)
import json, os, ssl, subprocess, sys, urllib.request

def card(text, desc, priority):
    tok = subprocess.run(["security", "find-generic-password", "-s", "topics", "-a", "agent-token", "-w"],
                         capture_output=True, text=True).stdout.strip()
    ctx = ssl.create_default_context(cafile=os.path.expanduser("~/Projects/topics-app/certs/ca-cert.pem"))
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    body = {"text": text, "description": desc, "priority": priority, "status": "todo", "model": "claude-sonnet-5-5"}
    req = urllib.request.Request("https://127.0.0.1:3333/api/boards/attilio-mn52yh/tasks", method="POST",
                                 data=json.dumps(body).encode(),
                                 headers={"x-agent-token": tok, "content-type": "application/json"})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        r.read()

# Dopo l'update, due lavori trovati dalla verifica del 25/10, da fare in entrambi i casi
DOPO = (
    "1) Il cancello di occupato e' una lista di eccezioni che cresce a ogni automazione notturna: dal 16/10 6 notti fallite su 8 "
    "e nessuna per una persona (sottoagenti, ritentativo-chiave, mirror di consegna, profilo heap, npm). Con la 10.7, che fa sopravvivere "
    "al riavvio turni in coda, risultati dei figli e risvegli, rovescialo: si interrompe solo se ha scritto una PERSONA negli ultimi "
    "2 minuti; il resto lo reggono il drain di 300 s e la ripresa. Test sui casi storici (log righe 523-673) e un mutante. Correggi anche "
    "la docstring «5 s di drain» (sono 300) e in ~/.claude/jarvis/memory/tools/router.md la riga «Fermo = 0 task running/queued…».\n"
    "2) Ogni tentativo lascia una copia di ripristino da circa 500 MB: il 25/10 erano 13 per 6,2 GB in ~/.openclaw.update-captures "
    "piu' 609 MB di stage del 24/10. Usa il comando nativo `openclaw update cleanup` (leggi prima --help: deve restare la copia "
    "dell'ultimo update riuscito), misura prima e dopo con du, e fai si' che safe-update pulisca anche quando reconcile_ledger da' False.\n"
)

atteso = sys.argv[1]
ver = subprocess.run(["openclaw", "--version"], capture_output=True, text=True).stdout.strip()
if atteso in ver:
    card(f"OpenClaw e' alla {atteso}: semplifica il cancello dell'update e togli 6,8 GB di copie",
         f"Stanotte openclaw-safe-update ha portato OpenClaw alla {atteso} («{ver}»).\n\n" + DOPO +
         "\nNon toccare i file di regole di Jarvis. A lavoro finito: commento con la prova, poi done (non review).", 1)
    print("NO_REPLY")
    sys.exit(0)

log = os.path.expanduser("~/.claude/jarvis/logs/openclaw-safe-update.log")
try:
    coda = "".join(open(log, encoding="utf-8", errors="replace").readlines()[-40:])
except OSError as e:
    coda = f"(log non leggibile: {e})"

desc = (
    f"Stanotte openclaw-safe-update doveva portare OpenClaw alla {atteso}, ma `openclaw --version` dice «{ver}». "
    "È la quinta notte di fila che non passa: il 25/10 è stato corretto il falso positivo dei mirror di consegna (commit e42cd57) "
    "e il profilo heap non apre finestre fra le 04:00 e le 06:30.\n\n"
    "Compito: dal log capisci perché non è passato. Correggi la causa, con un test che fallisce sul codice vecchio, poi aggiorna "
    "SOLO con `openclaw-safe-update` in una finestra tranquilla (mai `openclaw update` a mano). Barra: `openclaw --version` "
    f"dice {atteso} e l'health gate è verde. Non toccare i file di regole di Jarvis (~/.openclaw/AGENTS.md, OPS-ATTILIO.md, TOOLS.md). "
    "Codice in ~/.claude/jarvis/scripts/openclaw-safe-update/. Rischio gia' noto: il battito delle 05:05 non e' escluso dal cancello "
    "e una validazione riuscita ha preso 21 minuti; a Mac carico puo' superare i 40 e farsi interrompere.\n\n"
    "Dopo l'update, nella stessa card:\n" + DOPO +
    "\nA lavoro finito: un commento con l'esito e la prova, poi done (non review).\n\n"
    f"Ultime righe del log:\n```\n{coda}\n```"
)
card("OpenClaw non si è aggiornato stanotte: capire perché e aggiornarlo", desc, 3)
# la card sulla board basta: niente messaggio ad Attilio
print("NO_REPLY")
