#!/usr/bin/env python3
"""Cattura i widget di Übersicht come li vede il desktop, anche con altre finestre sopra, e li ritaglia uno per uno.

Uso: desk_shot.py [larghezza massima dei ritagli, default 760]
I file vanno in ~/.topics/reminders-desk/shots (cartella privata: contengono i titoli dei promemoria).
Si tolgono quando non servono più: trash ~/.topics/reminders-desk/shots
"""
import glob
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
OUT = os.path.join(HOME, ".topics", "reminders-desk", "shots")
MAXW = int(sys.argv[1]) if len(sys.argv) > 1 else 760
BACKDROP = "#4a4a52"  # grigio medio al posto dello sfondo: le carte sono semitrasparenti

JXA = r"""
ObjC.import('CoreGraphics');
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw));
console.log(JSON.stringify(list
  .filter(w => /bersicht/i.test(String(w.kCGWindowOwnerName || '')) && w.kCGWindowLayer === -1 && w.kCGWindowIsOnscreen)
  .map(w => ({id: w.kCGWindowNumber, b: w.kCGWindowBounds}))));
"""


def sh(args):
    return subprocess.run(args, capture_output=True, text=True)


def main():
    os.makedirs(OUT, mode=0o700, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, "*.png")):
        os.remove(old)
    p = sh(["/usr/bin/osascript", "-l", "JavaScript", "-e", JXA])
    lines = (p.stdout + p.stderr).strip().splitlines()
    wins = json.loads(lines[-1]) if lines else []
    if not wins:
        print("nessuna finestra di Übersicht in schermo")
        return 1
    for n, win in enumerate(wins, 1):
        full = os.path.join(OUT, "win-%d.png" % n)
        if sh(["/usr/sbin/screencapture", "-x", "-o", "-l", str(win["id"]), full]).returncode != 0:
            print("schermo %d: cattura non riuscita" % n)
            continue
        px = int(sh(["magick", "identify", "-format", "%w", full]).stdout)
        scale = px / win["b"]["Width"]
        # Le carte hanno fondo al 76%: soglia al 50% le separa dalle ombre, che le unirebbero.
        cc = sh(["magick", full, "-alpha", "extract", "-threshold", "50%",
                 "-define", "connected-components:verbose=true",
                 "-define", "connected-components:area-threshold=3000",
                 "-connected-components", "8", "null:"]).stdout
        found = 0
        for line in cc.splitlines():
            m = re.match(r"\s*\d+: (\d+)x(\d+)\+(\d+)\+(\d+) \S+ (\d+) (.*)$", line)
            if not m or "255" not in m.group(6):
                continue
            w, h, x, y = (int(m.group(i)) for i in range(1, 5))
            found += 1
            crop = os.path.join(OUT, "schermo%d-widget%d.png" % (n, found))
            sh(["magick", full, "-crop", "%dx%d+%d+%d" % (w + 12, h + 12, max(0, x - 6), max(0, y - 6)), "+repage",
                "-background", BACKDROP, "-flatten", "-resize", "%dx>" % MAXW, crop])
            print("schermo %d (%dx%d pt): widget a %d,%d pt, %dx%d pt -> %s"
                  % (n, win["b"]["Width"], win["b"]["Height"], x / scale, y / scale, w / scale, h / scale, crop))
        if not found:
            print("schermo %d (%dx%d pt): nessun widget visibile" % (n, win["b"]["Width"], win["b"]["Height"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
