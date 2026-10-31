#!/usr/bin/env python3
"""Patch sul plugin WhatsApp di OpenClaw 2026.10.x: alla ripartenza del gateway ripesca i messaggi
arrivati mentre era giu' fino a 10 minuti indietro, non 60 secondi.
Upstream (shouldSkipStaleAppend) all'avvio scarta gli «append» piu' vecchi di connectedAt - 60 s; un
riavvio dura 94-144 s (misurato 15/10), quindi un messaggio scritto a inizio riavvio restava senza
risposta. Doppioni no: i messaggi gia' gestiti hanno la pietra tombale nella coda durable
(queueResult «completed») e non ripartono.

  openclaw-wa-catchup.py check    exit 0 = patch su disco E nel gateway in esecuzione
  openclaw-wa-catchup.py apply    idempotente; poi, a OpenClaw fermo, oc-restart
  openclaw-wa-catchup.py revert

OPENCLAW_WA_DIST=<dir> punta a una copia del dist del plugin per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-wa-catchup"
ORIG = "const APPEND_RECENT_GRACE_MS = 6e4;"
NEW = f"const APPEND_RECENT_GRACE_MS = 6e5; // {MARK}: ripesca 10 min dopo un riavvio"


def targets():
    roots = [os.environ["OPENCLAW_WA_DIST"]] if os.environ.get("OPENCLAW_WA_DIST") else \
        glob.glob(os.path.expanduser("~/.openclaw/npm/projects/openclaw-whatsapp-*/node_modules/@openclaw/whatsapp/dist"))
    hits = []
    for r in roots:
        for f in glob.glob(os.path.join(r, "**", "*.mjs"), recursive=True) + glob.glob(os.path.join(r, ".setup", "*.mjs")):
            t = open(f, errors="replace").read()
            if ORIG in t or MARK in t:
                hits.append(f)
    if not hits:
        sys.exit("ERRORE: APPEND_RECENT_GRACE_MS non trovata nel plugin WhatsApp: rivedi la patch a mano")
    return sorted(set(hits))


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".wa-catchup-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)


def gateway_started_after(path):
    if os.environ.get("OPENCLAW_WA_DIST"):
        return True
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
    paths = targets()
    if cmd == "check":
        off = [p for p in paths if MARK not in open(p).read()]
        if off:
            print(f"FAIL patch assente in {len(off)} file: openclaw-wa-catchup.py apply + oc-restart a OpenClaw fermo")
            return 1
        if not all(gateway_started_after(p) for p in paths):
            print("FAIL patch su disco ma il gateway gira col codice vecchio: oc-restart a OpenClaw fermo")
            return 1
        print(f"ok   patch openclaw-wa-catchup attiva ({len(paths)} file)")
        return 0
    if cmd not in ("apply", "revert"):
        sys.exit(__doc__)
    for p in paths:
        text = open(p).read()
        if cmd == "apply" and MARK not in text:
            if text.count(ORIG) != 1:
                sys.exit(f"ERRORE: {p}: costante cambiata, rivedi a mano")
            write(p, text.replace(ORIG, NEW, 1))
        elif cmd == "revert" and MARK in text:
            write(p, text.replace(NEW, ORIG, 1))
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        if r.returncode:
            sys.exit(f"ERRORE di sintassi in {p}: {r.stderr[:300]}")
    print(f"{cmd} fatto su {len(paths)} file; ora, a OpenClaw fermo: oc-restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
