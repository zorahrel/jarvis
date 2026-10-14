#!/usr/bin/env python3
"""Patch su OpenClaw 2026.10.x: un sottoagente lungo (30-80 min) che produce piu' di 20000 righe o
8 MB di stream-json viene chiuso in «subagent-error» con «CLI JSONL output exceeded ... refusing to
parse output». Il lavoro era gia' su git, si perdeva solo il resoconto (8 volte il 14/10).
Il tetto resta solo come rete contro un processo impazzito: 1M righe, 128 MiB per turno.
Il limite di una singola riga (maxPendingLineChars) resta quello di OpenClaw.

  openclaw-cli-output-limit.py check    exit 0 = tetti alzati su disco E nel gateway in esecuzione
  openclaw-cli-output-limit.py apply    idempotente; poi, a OpenClaw fermo:
                                        launchctl kickstart -k gui/$UID/ai.openclaw.gateway
  openclaw-cli-output-limit.py revert   rimette i valori di OpenClaw (stesso riavvio dopo)

OPENCLAW_DIST=<dir> punta a una copia di dist/ per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-cli-output-limit"
ORIG = ("\tmaxTurnRawChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,\n"
        "\tmaxPendingLineChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,\n"
        "\tmaxTurnLines: 2e4\n")
NEW = ("\tmaxTurnRawChars: 134217728,\n"
       "\tmaxPendingLineChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,\n"
       f"\tmaxTurnLines: 1e6 // {MARK}: era 2e4 righe e 8 MiB\n")


def dist_dir():
    if os.environ.get("OPENCLAW_DIST"):
        return os.environ["OPENCLAW_DIST"]
    oc = subprocess.run(["which", "openclaw"], capture_output=True, text=True).stdout.strip()
    return os.path.join(os.path.dirname(os.path.realpath(oc)), "dist")


def target():
    hits = [f for f in glob.glob(os.path.join(dist_dir(), "*.mjs"))
            if "const CLI_STREAM_JSON_OUTPUT_LIMITS = Object.freeze({" in open(f, errors="replace").read()]
    if len(hits) != 1:
        sys.exit(f"ERRORE: {len(hits)} file con CLI_STREAM_JSON_OUTPUT_LIMITS, atteso 1: rivedi a mano")
    return hits[0]


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".cli-output-limit-")
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
    if cmd == "check":
        if not on:
            print("FAIL patch assente: openclaw-cli-output-limit.py apply + kickstart a OpenClaw fermo")
            return 1
        if not gateway_started_after(path):
            print("FAIL patch su disco ma il gateway gira col codice vecchio: kickstart a OpenClaw fermo")
            return 1
        print("ok   patch openclaw-cli-output-limit attiva")
        return 0
    if cmd == "apply":
        if on:
            print("gia' applicata")
            return 0
        if text.count(ORIG) != 1:
            sys.exit("ERRORE: i tetti di OpenClaw sono cambiati: rivedi la patch a mano")
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
    print(f"{cmd} fatto; ora, a OpenClaw fermo: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
    return 0


if __name__ == "__main__":
    sys.exit(main())
