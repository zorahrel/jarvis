#!/usr/bin/env python3
"""Patch su OpenClaw 2026.10.7: chat.history non fallisce piu' sulle sessioni in cui un cron ha scritto.
Errore nel log: «chat.history ... Error: Cron job names must be prepared before projecting forwarded messages»
(397 volte il 26/10 dalle 15:05: il pannello non apriva piu' la chat di Jarvis su Discord).
Causa: un cron mirato a una sessione di canale scrive un messaggio con provenance internal_system/cron e jobId.
Quando la sessione ha un legame claude-cli ma un provider diverso, prepareCliSessionHistoryReader legge la coda
per decidere se importare la storia CLI e la proietta senza risolutore dei nomi dei cron: il core lancia.
Upstream: issue #180920, chiusa dalla PR #181311 (main dal 23/10, non nella 10.7), che passa a quella lettura
un risolutore vuoto (i nomi veri li prepara il worker dopo aver scelto la pagina). Qui si riporta la stessa riga.

  openclaw-cron-history-names.py check    exit 0 = patch su disco E nel gateway in esecuzione (o fix upstream)
  openclaw-cron-history-names.py apply    idempotente; poi, a OpenClaw fermo, oc-restart
  openclaw-cron-history-names.py revert

OPENCLAW_DIST=<dir> punta a una copia di dist/ per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-cron-history-names"
FN = "async function prepareCliSessionHistoryReader("
ANCHOR = "\t\t\treadOnly: true,\n\t\t\tdeferProfileDisplay: true\n\t\t})).rawMessages.length) return;\n"
PATCHED = ("\t\t\treadOnly: true,\n\t\t\tdeferProfileDisplay: true,\n"
           f"\t\t\tresolveCronJobName: () => void 0 // {MARK}\n"
           "\t\t})).rawMessages.length) return;\n")


def dist_dir():
    if os.environ.get("OPENCLAW_DIST"):
        return os.environ["OPENCLAW_DIST"]
    oc = subprocess.run(["which", "openclaw"], capture_output=True, text=True).stdout.strip()
    return os.path.join(os.path.dirname(os.path.realpath(oc)), "dist")


def target():
    hits = [f for f in glob.glob(os.path.join(dist_dir(), "*.mjs")) if FN in open(f, errors="replace").read()]
    if len(hits) != 1:
        sys.exit(f"ERRORE: {len(hits)} file con prepareCliSessionHistoryReader, atteso 1: rivedi a mano")
    return hits[0]


def is_upstream(text):
    """Il codice ha gia' la forma del fix: la lettura di idoneita' passa un risolutore dei nomi dei cron."""
    i = text.find(FN)
    body = text[i:text.find("const redaction", i)]
    return "resolveCronJobName" in body


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".cron-history-names-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)


def gateway_started_after(path):
    if os.environ.get("OPENCLAW_DIST"):
        return True  # copia di prova: nessun gateway da confrontare
    out = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/ai.openclaw.gateway"], capture_output=True, text=True).stdout
    m = re.search(r"^\s*pid = (\d+)", out, re.M)
    if not m:
        return False
    et = subprocess.run(["ps", "-o", "etime=", "-p", m.group(1)], capture_output=True, text=True).stdout.strip()
    parts = [int(x) for x in re.split(r"[-:]", et)] if et else []
    secs = sum(k * v for k, v in zip([1, 60, 3600, 86400], reversed(parts)))
    return time.time() - secs > os.path.getmtime(path)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    path = target()
    text = open(path).read()
    on = MARK in text
    upstream = not on and is_upstream(text)
    if cmd == "check":
        if upstream:
            print("ok   fix upstream presente (la lettura di idoneita' CLI passa gia' il risolutore): patch non serve")
            return 0
        if not on:
            print("FAIL patch assente: openclaw-cron-history-names.py apply + oc-restart a OpenClaw fermo")
            return 1
        if not gateway_started_after(path):
            print("FAIL patch su disco ma il gateway gira col codice vecchio: oc-restart a OpenClaw fermo")
            return 1
        print("ok   patch openclaw-cron-history-names attiva")
        return 0
    if cmd == "apply":
        if on or upstream:
            print("gia' a posto")
            return 0
        i = text.find(FN)
        if text.count(ANCHOR) != 1 or text.find(ANCHOR, i) == -1 or text.find(ANCHOR, i) > text.find("const redaction", i):
            sys.exit("ERRORE: la lettura di idoneita' in prepareCliSessionHistoryReader e' cambiata: rivedi la patch a mano")
        write(path, text.replace(ANCHOR, PATCHED, 1))
    elif cmd == "revert":
        if not on:
            print("niente da togliere")
            return 0
        if text.count(PATCHED) != 1:
            sys.exit("ERRORE: la riga patchata non e' piu' quella scritta da apply: rivedi a mano")
        write(path, text.replace(PATCHED, ANCHOR, 1))
    else:
        sys.exit(__doc__)
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ERRORE di sintassi in {path}: {r.stderr[:300]}")
    print(f"{cmd} fatto; ora, a OpenClaw fermo: oc-restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
