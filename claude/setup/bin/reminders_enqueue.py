#!/usr/bin/env python3
# Mette in coda un'azione del widget Promemoria e sveglia il job che la esegue (com.jarvis.reminders-act).
import json
import os
import subprocess
import sys
import time

QUEUE = os.path.join(os.path.expanduser("~"), ".topics", "reminders-desk", "queue")
LABEL = "com.jarvis.reminders-act"


def main():
    req = json.loads(sys.argv[1])  # JSON rotto = nessuna azione
    os.makedirs(QUEUE, exist_ok=True)
    name = "%d-%d.json" % (time.time_ns(), os.getpid())
    tmp = os.path.join(QUEUE, "." + name)  # il job guarda solo i *.json: il punto evita file a metà
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(req, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(QUEUE, name))
    subprocess.run(["launchctl", "kickstart", "gui/%d/%s" % (os.getuid(), LABEL)], check=False)


if __name__ == "__main__":
    main()
