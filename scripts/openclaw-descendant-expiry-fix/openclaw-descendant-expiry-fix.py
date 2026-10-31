#!/usr/bin/env python3
"""Patch su OpenClaw 2026.10.5-10.7 (e 10.10-beta.3): la risposta di un turno di un sottoagente persistente
non aspetta piu' i nipoti lanciati dai turni PRIMA, e non scade dopo 30 minuti senza un tentativo.
Caso del 24/10 19:47 (run 5b137a57): sessione orchestratrice con spawnMode "session", turno 2 di 15 s che
non lancia niente, ma `countPendingDescendantRuns(entry.childSessionKey)` conta tutto l'albero della
sessione, compresi i tre filoni lanciati dal turno 1 (uno finito alle 20:07). Ogni 15 s «defer-descendants»,
nessun tentativo, a 30 min `resolveDeferredCleanupDecision` da' give-up (expiry) e la riga resta sospesa
fino allo sweeper dei 7 giorni. I filoni del turno 1 hanno gia' il loro risveglio (requester-settle).
Il conteggio sta in due punti, e vanno corretti tutti e due (25/10, bocciatura della prima versione):
il rinvio nel registro e il gate all'inizio di `runSubagentAnnounceFlow`, che con nipoti pendenti
risponde «retryable» prima di tentare. In entrambi il conteggio salta i figli diretti nati prima che il
turno partisse (`execution.startedAt`, nel payload `startedAt`), e con loro il loro sottoalbero.

  openclaw-descendant-expiry-fix.py check    exit 0 = patch su disco E nel gateway in esecuzione (o fix upstream)
  openclaw-descendant-expiry-fix.py apply    idempotente; poi, a OpenClaw fermo, oc-restart
  openclaw-descendant-expiry-fix.py revert

OPENCLAW_DIST=<dir> punta a una copia di dist/ per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-descendant-expiry-fix"

# 1. il registro passa l'inizio del turno al conteggio che decide il rinvio (solo li', non sul risveglio)
CALL_ANCHOR = "const activeDescendantRuns = Date.now() >= resolveAnnounceDeliveryDeadline("
CALL_ORIG = "? 0 : await params.countPendingDescendantRuns(entry.childSessionKey, assertCurrent);\n"
CALL_NEW = ("? 0 : await params.countPendingDescendantRuns(entry.childSessionKey, assertCurrent, "
            f"entry.execution?.startedAt ?? entry.createdAt); // {MARK}\n")

# 2. la lettura (usata da registro e annuncio) scarta i figli diretti nati prima del turno: senza di loro il sottoalbero non e' raggiungibile
READ_ANCHOR = "async function countPendingDescendantRuns(rootSessionKey, assertCurrent"
READ_ORIG = [
    ("async function countPendingDescendantRuns(rootSessionKey, assertCurrent) {\n",
     f"function dropChildrenSpawnedBefore(runs, rootSessionKey, spawnedSince) {{ // {MARK}\n"
     "\tif (typeof spawnedSince !== \"number\") return runs;\n"
     "\tconst root = rootSessionKey.trim();\n"
     "\tconst earlier = new Set();\n"
     "\tfor (const entry of runs.values()) if (entry.requesterSessionKey?.trim() === root && typeof entry.createdAt === \"number\" && entry.createdAt < spawnedSince) earlier.add(entry.childSessionKey.trim());\n"
     "\tif (!earlier.size) return runs;\n"
     "\treturn new Map([...runs].filter(([, entry]) => !earlier.has(entry.childSessionKey.trim())));\n"
     "}\n"
     "async function countPendingDescendantRuns(rootSessionKey, assertCurrent, spawnedSince) {\n"),
    ("\t\treturn countPendingDescendantRunsFromRuns(new Map(runs), rootSessionKey);\n",
     f"\t\treturn countPendingDescendantRunsFromRuns(dropChildrenSpawnedBefore(new Map(runs), rootSessionKey, spawnedSince), rootSessionKey); // {MARK}\n"),
]


def dist_dir():
    if os.environ.get("OPENCLAW_DIST"):
        return os.environ["OPENCLAW_DIST"]
    oc = subprocess.run(["which", "openclaw"], capture_output=True, text=True).stdout.strip()
    return os.path.join(os.path.dirname(os.path.realpath(oc)), "dist")


def target(anchor):
    hits = [f for f in glob.glob(os.path.join(dist_dir(), "*.mjs"))
            if anchor in open(f, errors="replace").read()]
    if len(hits) != 1:
        sys.exit(f"ERRORE: {len(hits)} file con «{anchor[:50]}», atteso 1: rivedi a mano")
    return hits[0]


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".descendant-expiry-fix-")
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


# 3. il gate dell'annuncio: ogni tentativo passa da qui, e senza l'inizio del turno conta ancora i filoni vecchi
GATE_ANCHOR = "await countPendingDescendantRuns(params.childSessionKey, () => {"
GATE_ORIG = ("if (!childSessionEffectsAllowed()) throw new Error(\"Subagent child-session effects are no longer current.\");\n"
             "\t\t\t}))) > 0) {\n")
GATE_NEW = ("if (!childSessionEffectsAllowed()) throw new Error(\"Subagent child-session effects are no longer current.\");\n"
            f"\t\t\t}}, params.startedAt))) > 0) {{ // {MARK}\n")


def edits():
    """(file, [(originale, patchato)]) per i tre file toccati; il primo decide se il fix e' upstream."""
    return [(target(CALL_ANCHOR), [(CALL_ORIG, CALL_NEW)]), (target(READ_ANCHOR), READ_ORIG),
            (target(GATE_ANCHOR), [(GATE_ORIG, GATE_NEW)])]


def node_check(path):
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ERRORE di sintassi in {path}: {r.stderr[:300]}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    files = edits()
    texts = {path: open(path).read() for path, _ in files}
    on = [MARK in texts[path] for path, _ in files]
    # il codice non ha piu' la forma del difetto (chiamata senza inizio turno): fix ufficiale o rifattorizzato
    upstream = not any(on) and CALL_ORIG not in texts[files[0][0]]
    if cmd == "check":
        if upstream:
            print("ok   la chiamata del rinvio e' cambiata upstream: verifica a mano se il fix c'e', patch non applicabile")
            return 0
        if not all(on):
            print("FAIL patch assente o a meta': openclaw-descendant-expiry-fix.py apply + oc-restart a OpenClaw fermo")
            return 1
        if not all(gateway_started_after(path) for path, _ in files):
            print("FAIL patch su disco ma il gateway gira col codice vecchio: oc-restart a OpenClaw fermo")
            return 1
        print("ok   patch openclaw-descendant-expiry-fix attiva")
        return 0
    if cmd == "apply":
        if all(on) or upstream:
            print("gia' a posto")
            return 0
        # prima si verificano tutti gli ancoraggi, poi si scrive: mai un file patchato e l'altro no
        for path, pairs in files:
            if MARK in texts[path]:
                continue
            for orig, _ in pairs:
                if texts[path].count(orig) != 1:
                    sys.exit(f"ERRORE: {os.path.basename(path)} e' cambiato: rivedi la patch a mano")
        for path, pairs in files:
            if MARK in texts[path]:
                continue
            text = texts[path]
            for orig, new in pairs:
                text = text.replace(orig, new, 1)
            write(path, text)
            node_check(path)
    elif cmd == "revert":
        if not any(on):
            print("niente da togliere")
            return 0
        for path, pairs in files:
            if MARK not in texts[path]:
                continue
            text = texts[path]
            for orig, new in pairs:
                text = text.replace(new, orig, 1)
            write(path, text)
            node_check(path)
    else:
        sys.exit(__doc__)
    print(f"{cmd} fatto; ora, a OpenClaw fermo: oc-restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
