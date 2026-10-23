#!/usr/bin/env python3
"""Patch su OpenClaw 2026.10.5/10.6: un risveglio a fine exec non muore piu' per «sessione non pronta».
Regressione della 10.5 (issue upstream #168637; fix #177063 mergiato il 19/10 ma non ancora in una release:
la 10.6 ha ancora il codice sotto). Il run di un evento di sessione rilegge le impostazioni della sessione con
`readGenerationSettings`, che torna `undefined` se c'e' QUALSIASI scrittura non conclusa sulla stessa sessione
(`pending(true)`, controllo di membership), anche il bookkeeping del run stesso: il run fallisce con
«Session event execution failed» e il fallimento passeggero diventa definitivo (tutti i candidati di fallback
muoiono in 10-60 ms). Misurato 22-23/10: 21 risvegli persi su 58 (36%) in 26 ore, 23 marker
`run-failed-before-reply` contro 0 tra il 4 e il 21/10.
Qui la guardia diventa quella della funzione gemella `readGeneration`: `generationPending()`, che aspetta solo
una scrittura che cambia davvero la generazione (le impostazioni vengono da `read.generation.current`, la
membership non c'entra).

  openclaw-session-settings-fix.py check    exit 0 = patch su disco E nel gateway in esecuzione (o fix upstream)
  openclaw-session-settings-fix.py apply    idempotente; poi, a OpenClaw fermo, oc-restart
  openclaw-session-settings-fix.py revert

OPENCLAW_DIST=<dir> punta a una copia di dist/ per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-session-settings-fix"
ORIG = "\t\treadGenerationSettings: () => active && !pending(true) ? read.generation?.current : void 0,\n"
NEW = f"\t\treadGenerationSettings: () => active && !generationPending() ? read.generation?.current : void 0, // {MARK}\n"
ANCHOR = "readGenerationSettings: () =>"


def dist_dir():
    if os.environ.get("OPENCLAW_DIST"):
        return os.environ["OPENCLAW_DIST"]
    oc = subprocess.run(["which", "openclaw"], capture_output=True, text=True).stdout.strip()
    return os.path.join(os.path.dirname(os.path.realpath(oc)), "dist")


def target():
    hits = [f for f in glob.glob(os.path.join(dist_dir(), "*.mjs"))
            if ANCHOR in open(f, errors="replace").read()]
    if len(hits) != 1:
        sys.exit(f"ERRORE: {len(hits)} file con readGenerationSettings, atteso 1: rivedi a mano")
    return hits[0]


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".session-settings-fix-")
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
    upstream = not on and ORIG not in text  # il codice non ha piu' la forma del difetto: fix ufficiale
    if cmd == "check":
        if upstream:
            print("ok   fix upstream presente (readGenerationSettings non usa piu' pending(true)): patch non serve")
            return 0
        if not on:
            print("FAIL patch assente: openclaw-session-settings-fix.py apply + oc-restart a OpenClaw fermo")
            return 1
        if not gateway_started_after(path):
            print("FAIL patch su disco ma il gateway gira col codice vecchio: oc-restart a OpenClaw fermo")
            return 1
        print("ok   patch openclaw-session-settings-fix attiva")
        return 0
    if cmd == "apply":
        if on or upstream:
            print("gia' a posto")
            return 0
        if text.count(ORIG) != 1:
            sys.exit("ERRORE: readGenerationSettings e' cambiata: rivedi la patch a mano")
        write(path, text.replace(ORIG, NEW, 1))
    elif cmd == "revert":
        if not on:
            print("niente da togliere")
            return 0
        write(path, text.replace(NEW, ORIG, 1))
    else:
        sys.exit(__doc__)
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ERRORE di sintassi in {path}: {r.stderr[:300]}")
    print(f"{cmd} fatto; ora, a OpenClaw fermo: oc-restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
