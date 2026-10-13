#!/usr/bin/env python3
"""Patch ponte per OpenClaw 2026.9.8: risposta finale WhatsApp rifiutata con «The reply channel
changed or cannot preserve its sender» quando il turno gira in una vista del registro plugin del
gateway (nasce da ogni refresh del model runtime con config cambiata dall'ultima attivazione).
Backport della condizione isPluginRegistryGatewayViewOf di openclaw#160009, gia' in 2026.10.2:
con l'update il file cambia e la patch non serve piu' (apply diventa un no-op).

  openclaw-durable-view.py check    exit 0 = fix attivo su disco E nel gateway in esecuzione
  openclaw-durable-view.py apply    idempotente; poi, a OpenClaw fermo:
                                    launchctl kickstart -k gui/$UID/ai.openclaw.gateway
  openclaw-durable-view.py revert   toglie la riga (stesso riavvio dopo)

OPENCLAW_DIST=<dir> punta a una copia di dist/ per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-durable-view"
ANCHOR = "\tif (!cfg || !isDeepStrictEqual(cfg.channels?.[input.channel], input.cfg.channels?.[input.channel])"
LINE = ("\tif (admittedChannel && admittedChannel === getPluginRegistryGatewayChannelRegistration(current, input.channel)"
        " && getPluginRegistryGatewayOwner(current) === owner) return runOutsidePluginRuntimeGenerationScope("
        "() => withPluginRuntimeRegistryScope(current, () => deliver(input.cfg, assertCurrent)));"
        f" // {MARK}: vista dello stesso gateway, backport openclaw#160009\n")
UPSTREAM = "isPluginRegistryGatewayViewOf("


def dist_dir():
    if os.environ.get("OPENCLAW_DIST"):
        return os.environ["OPENCLAW_DIST"]
    oc = subprocess.run(["which", "openclaw"], capture_output=True, text=True).stdout.strip()
    return os.path.join(os.path.dirname(os.path.realpath(oc)), "dist")


def target():
    hits = [f for f in glob.glob(os.path.join(dist_dir(), "durable-delivery-*.mjs"))
            if "function withDurableDeliveryRuntime" in open(f, errors="replace").read()]
    if len(hits) != 1:
        sys.exit(f"ERRORE: {len(hits)} file con withDurableDeliveryRuntime, atteso 1: rivedi a mano")
    return hits[0]


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".durable-view-")
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
    if UPSTREAM in text:
        print("ok   fix upstream presente (isPluginRegistryGatewayViewOf): la patch non serve")
        return 0
    on = MARK in text
    if cmd == "check":
        if not on:
            print("FAIL patch assente: openclaw-durable-view.py apply + kickstart a OpenClaw fermo")
            return 1
        if not gateway_started_after(path):
            print("FAIL patch su disco ma il gateway gira col codice vecchio: kickstart a OpenClaw fermo")
            return 1
        print("ok   patch openclaw-durable-view attiva")
        return 0
    if cmd == "apply":
        if on:
            print("gia' applicata")
            return 0
        if text.count(ANCHOR) != 1:
            sys.exit("ERRORE: la riga del rifiuto e' cambiata: rivedi la patch a mano")
        write(path, text.replace(ANCHOR, LINE + ANCHOR, 1))
    elif cmd == "revert":
        if not on:
            print("niente da togliere")
            return 0
        write(path, text.replace(LINE, "", 1))
    else:
        sys.exit(__doc__)
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ERRORE di sintassi in {path}: {r.stderr[:300]}")
    print(f"{cmd} fatto; ora, a OpenClaw fermo: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
    return 0


if __name__ == "__main__":
    sys.exit(main())
