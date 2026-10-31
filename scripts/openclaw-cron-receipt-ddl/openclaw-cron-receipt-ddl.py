#!/usr/bin/env python3
"""Patch su OpenClaw 2026.10.7: gli exec degli agenti non falliscono piu' per «integrity admission».
Errore nel log: «spawn failed: ... service child cleanup identity lost: Direct shared-state reader requires
current integrity admission» (18 volte il 26/10, issue upstream #177656 ancora aperta).
Causa: a ogni run di cron il worker di stato riesegue `CREATE TABLE/INDEX IF NOT EXISTS cron_run_receipts`
(`ensureCronRunReceiptSchema`, chiamata alla reserve e al bind). Non cambia niente nel DB, ma il classificatore
di schema la conta come mutazione e alza di 2 la revision dell'integrita' condivisa: ogni exec che aveva gia'
preparato il lettore delle approvazioni lancia l'errore al messaggio «prepared» del relay. Riprodotto col worker
vero (test-epoca.mjs: revision 0 -> 2, stesso errore). Il fix upstream e' #170548 (main dal 13/10, nelle
2026.10.10-beta), non nella 10.7: qui se ne riporta la parte di cron, cioe' il DDL gira solo se tabella o
indici mancano davvero (fatti di schema gia' ammessi).

  openclaw-cron-receipt-ddl.py check    exit 0 = patch su disco E nel gateway in esecuzione (o fix upstream)
  openclaw-cron-receipt-ddl.py apply    idempotente; poi, a OpenClaw fermo, oc-restart
  openclaw-cron-receipt-ddl.py revert

OPENCLAW_DIST=<dir> punta a una copia di dist/ per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-cron-receipt-ddl"
ANCHOR = "function ensureCronRunReceiptSchema(database) {\n"
GUARD = ("\tconst facts = {fn}(database); // {mark}\n"
         "\tif (facts?.tables.has(\"cron_run_receipts\") && facts.indexes.has(\"idx_cron_run_receipts_active_job\")"
         " && facts.indexes.has(\"idx_cron_run_receipts_job_history\")) return; // {mark}\n")
# import della funzione che legge i fatti di schema gia' ammessi: nome locale fisso, alias letto dall'export
LOCAL = "getAdmittedSqliteSchemaFacts$cronReceiptDdl"
IMPORT_RE = re.compile(r'^import \{ ([^}]*) \} from "(\./sqlite-schema-facts-[^"]+\.mjs)";\n', re.M)


def dist_dir():
    if os.environ.get("OPENCLAW_DIST"):
        return os.environ["OPENCLAW_DIST"]
    oc = subprocess.run(["which", "openclaw"], capture_output=True, text=True).stdout.strip()
    return os.path.join(os.path.dirname(os.path.realpath(oc)), "dist")


def target():
    hits = [f for f in glob.glob(os.path.join(dist_dir(), "*.mjs"))
            if "function ensureCronRunReceiptSchema(" in open(f, errors="replace").read()]
    if len(hits) != 1:
        sys.exit(f"ERRORE: {len(hits)} file con ensureCronRunReceiptSchema, atteso 1: rivedi a mano")
    return hits[0]


def facts_alias(path, text):
    """Alias con cui sqlite-schema-facts esporta getAdmittedSqliteSchemaFacts (cambia a ogni build)."""
    m = IMPORT_RE.search(text)
    if not m:
        return None, None
    src = open(os.path.join(os.path.dirname(path), m.group(2)), errors="replace").read()
    a = re.search(r"\bgetAdmittedSqliteSchemaFacts as (\w+)\b", src)
    return m, a.group(1) if a else None


def is_upstream(text):
    """Il codice ha gia' la forma del fix: la funzione non esegue piu' il DDL senza guardare lo schema."""
    i = text.find(ANCHOR)
    body = text[i:i + 600]
    return "getAdmittedSqliteSchemaFacts" in body or "SchemaEnsurer" in body or "ensureSqliteSchema" in body


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".cron-receipt-ddl-")
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


def patched(text, alias, m):
    names = m.group(1) + f", {alias} as {LOCAL}"
    text = text.replace(m.group(0), f'import {{ {names} }} from "{m.group(2)}"; // {MARK}\n', 1)
    return text.replace(ANCHOR, ANCHOR + GUARD.format(fn=LOCAL, mark=MARK), 1)


def unpatched(text):
    out = []
    for line in text.splitlines(keepends=True):
        if MARK not in line:
            out.append(line)
        elif line.startswith("import "):
            line = line.replace(f" // {MARK}", "")
            out.append(re.sub(r", \w+ as " + re.escape(LOCAL), "", line))
    return "".join(out)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    path = target()
    text = open(path).read()
    on = MARK in text
    upstream = not on and is_upstream(text)
    if cmd == "check":
        if upstream:
            print("ok   fix upstream presente (ensureCronRunReceiptSchema guarda gia' lo schema): patch non serve")
            return 0
        if not on:
            print("FAIL patch assente: openclaw-cron-receipt-ddl.py apply + oc-restart a OpenClaw fermo")
            return 1
        if not gateway_started_after(path):
            print("FAIL patch su disco ma il gateway gira col codice vecchio: oc-restart a OpenClaw fermo")
            return 1
        print("ok   patch openclaw-cron-receipt-ddl attiva")
        return 0
    if cmd == "apply":
        if on or upstream:
            print("gia' a posto")
            return 0
        m, alias = facts_alias(path, text)
        if not m or not alias or text.count(ANCHOR) != 1:
            sys.exit("ERRORE: ensureCronRunReceiptSchema o il suo import sono cambiati: rivedi la patch a mano")
        write(path, patched(text, alias, m))
    elif cmd == "revert":
        if not on:
            print("niente da togliere")
            return 0
        write(path, unpatched(text))
    else:
        sys.exit(__doc__)
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ERRORE di sintassi in {path}: {r.stderr[:300]}")
    print(f"{cmd} fatto; ora, a OpenClaw fermo: oc-restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
