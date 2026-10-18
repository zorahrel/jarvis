#!/usr/bin/env python3
"""Accende, spegne o rilancia i job che leggono i dati del desk (promemoria, agenda, repository).

Uso: desk_ctl.py read|agenda|repos on|off|run
Solo questi tre: la coda delle azioni e gli altri servizi qui non si toccano.
"""
import os
import subprocess
import sys

JOBS = {"read": "com.jarvis.reminders-desk", "agenda": "com.jarvis.reminders-agenda", "repos": "com.jarvis.desk-repos"}


def main(argv):
    if len(argv) != 3 or argv[1] not in JOBS or argv[2] not in ("on", "off", "run"):
        print(__doc__)
        return 2
    label = JOBS[argv[1]]
    domain = "gui/%d" % os.getuid()
    plist = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", label + ".plist")
    if argv[2] == "on":
        cmd = ["/bin/launchctl", "bootstrap", domain, plist]  # già acceso = errore innocuo, il job resta acceso
    elif argv[2] == "off":
        cmd = ["/bin/launchctl", "bootout", "%s/%s" % (domain, label)]
    else:
        cmd = ["/bin/launchctl", "kickstart", "-k", "%s/%s" % (domain, label)]
    return subprocess.run(cmd, capture_output=True).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv))
