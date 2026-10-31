#!/usr/bin/env python3
"""Patch su OpenClaw 2026.10.x: una chat col modello fissato a mano (/model) tiene la catena di ripiego, e il
ripiego non manda avvisi in chat.

Perche'. Il 24/10 alle 02:30 la chat WhatsApp di Attilio, fissata su anthropic/claude-opus-5-5, ha preso un
529 Overloaded: OpenClaw spegne la catena per i modelli scelti a mano (`disabled_by_model_override`, log
`fallbackConfigured:false, total:1`) e ha mandato ad Attilio l'errore grezzo in inglese. La catena di main
(Muse -> gpt-6-luna -> Sonnet x3) c'era ma non e' stata usata.
Due righe:
  1. resolveModelFallbackAvailability: il modello fissato resta il primo, poi la catena dell'agente.
     Il ripiego vale per il turno: la scelta salvata nella sessione non cambia.
  2. shouldDeliverFallbackNotice = false: niente «↪️ Model Fallback: ... (selected ...; overloaded)» in chat
     privata. L'evento resta nei log (lifecycle «fallback»).
Gli errori quando cade TUTTA la catena li traduce e li riprova il plugin errori-italiano
(~/Projects/openclaw-errori-italiano).

  openclaw-pinned-fallback.py check    exit 0 = patch su disco E nel gateway in esecuzione
  openclaw-pinned-fallback.py apply    idempotente; poi, a OpenClaw fermo, oc-restart
  openclaw-pinned-fallback.py revert

OPENCLAW_DIST=<dir> punta a una copia di dist/ per provarla."""
import glob, os, re, subprocess, sys, tempfile, time

MARK = "jarvis-patch openclaw-pinned-fallback"
EDITS = [
    {
        "anchor": "function resolveModelFallbackAvailability(params) {",
        "orig": '\tif (params.hasSessionModelOverride && !canUseConfiguredFallbacks) return { kind: "disabled_by_model_override" };\n',
        "new": f"\t/* {MARK}: un modello fissato a mano tiene la catena di ripiego dell'agente */\n",
    },
    {
        "anchor": "const shouldDeliverFallbackNotice = ",
        "orig": '\tconst shouldDeliverFallbackNotice = fallbackNoticeChatType !== "group" && fallbackNoticeChatType !== "channel";\n',
        "new": f"\tconst shouldDeliverFallbackNotice = false; // {MARK}: il ripiego e' silenzioso\n",
    },
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
        sys.exit(f"ERRORE: {len(hits)} file con «{anchor}», atteso 1: rivedi a mano")
    return hits[0]


def write(path, text):
    """Sostituzione atomica: il gateway non deve mai importare un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".pinned-fallback-")
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
    if cmd not in ("check", "apply", "revert"):
        sys.exit(__doc__)
    rc = 0
    for e in EDITS:
        path = target(e["anchor"])
        text = open(path).read()
        on = e["new"] in text
        name = os.path.basename(path)
        if cmd == "check":
            if not on:
                print(f"FAIL patch assente in {name}: openclaw-pinned-fallback.py apply + oc-restart")
                rc = 1
            elif not gateway_started_after(path):
                print(f"FAIL {name} patchato su disco ma il gateway gira col codice vecchio: oc-restart")
                rc = 1
            continue
        if cmd == "apply":
            if on:
                continue
            if text.count(e["orig"]) != 1:
                sys.exit(f"ERRORE: in {name} la riga da patchare e' cambiata: rivedi la patch a mano")
            text = text.replace(e["orig"], e["new"], 1)
        else:
            if not on:
                continue
            text = text.replace(e["new"], e["orig"], 1)
        write(path, text)
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        if r.returncode:
            sys.exit(f"ERRORE di sintassi in {path}: {r.stderr[:300]}")
    if cmd == "check":
        if rc == 0:
            print("ok   patch openclaw-pinned-fallback attiva")
        return rc
    print(f"{cmd} fatto; ora, a OpenClaw fermo: oc-restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
