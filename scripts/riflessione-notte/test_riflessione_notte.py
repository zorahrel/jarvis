"""Test di riflessione-notte: nessuna chiamata vera, openclaw / verifica / board-card sono script finti."""
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "riflessione-notte")


def today():
    return datetime.now(ZoneInfo("Europe/Rome")).strftime("%Y-%m-%d")


class RiflessioneNotteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.rifl = os.path.join(self.root, "proposte")
        os.mkdir(self.rifl)
        self.calls = os.path.join(self.root, "board-calls.jsonl")
        self.folder = os.path.join(self.root, "hub")
        os.mkdir(self.folder)

    def tearDown(self):
        self.tmp.cleanup()

    def fake(self, name, body):
        path = os.path.join(self.root, name)
        with open(path, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        return path

    def run_script(self, proposals, openclaw_rc=0, verify_rc=0, board_rc=0, openclaw_msg="", ran="true", reason="", run_status="ok"):
        if proposals is not None:
            with open(os.path.join(self.rifl, today() + ".md"), "w") as f:
                f.write(proposals)
        # cron run risponde subito (non aspetta la run); cron runs dà la run finita, con l'ora di adesso
        openclaw = self.fake("openclaw", (
            f'if [ "$2" = "runs" ]; then python3 -c \'import json,time;print(json.dumps({{"entries":[{{"action":"finished","status":"{run_status}","ts":int(time.time()*1000)}}]}}))\'; exit 0; fi\n'
            f'echo "{openclaw_msg}" >&2; echo \'{{"ok": true, "ran": {ran}, "reason": "{reason}"}}\'; exit {openclaw_rc}'))
        # la verifica vera è uno script python: qui un finto eseguito da /usr/bin/python3
        verify = os.path.join(self.root, "verifica.py")
        with open(verify, "w") as f:
            f.write(f'import sys\nprint("verifica finta")\nsys.exit({verify_rc})\n')
        board = self.fake("board-card", f'python3 -c \'import json,sys;print(json.dumps(sys.argv[1:]))\' "$@" >> "{self.calls}"; exit {board_rc}')
        env = dict(os.environ, OPENCLAW_BIN=openclaw, RIFL_VERIFY_BIN=verify, RIFL_DIR=self.rifl, BOARD_CARD_BIN=board)
        return subprocess.run(["/usr/bin/python3", SCRIPT], env=env, capture_output=True, text=True)

    def board_calls(self):
        if not os.path.exists(self.calls):
            return []
        with open(self.calls) as f:
            return [json.loads(l) for l in f if l.strip()]

    def doc(self, faults):
        return ("1. Proposta uno\n2. Proposta due\n\n## Correzioni viste\n- 28/10 22:44 canale logo «x»\n\n## Guasti\n"
                + "\n".join(faults) + "\n")

    def test_good_run_two_faults(self):
        other = os.path.join(self.root, "altra")
        os.mkdir(other)
        r = self.run_script(self.doc([
            f"- Jarvis si ferma sui progetti prioritari | {self.folder} | 28/10 22:44 canale logo «questo progetto è prioritario!»",
            f"- Il Freno non scatta: già è così! | {other} | 29/10 00:12 canale x «no»",
        ]))
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.board_calls()
        self.assertEqual(len(calls), 2)
        a = calls[0]
        self.assertEqual(a[a.index("--key") + 1], "guasto-jarvis-si-ferma-sui-progetti-prioritari")
        self.assertIn("--notte", a)
        self.assertEqual(a[a.index("--dir") + 1], self.folder)
        self.assertEqual(a[a.index("--title") + 1], "Jarvis si ferma sui progetti prioritari")
        self.assertIn("«questo progetto è prioritario!»", a[a.index("--desc") + 1])
        b = calls[1]
        self.assertEqual(b[b.index("--key") + 1], "guasto-il-freno-non-scatta-gia-e-cosi")
        self.assertEqual(b[b.index("--dir") + 1], other)
        self.assertIn("2 proposte, 2 card", r.stdout)
        self.assertEqual(len(r.stdout.strip().splitlines()), 1)

    def test_cron_run_fails(self):
        r = self.run_script(self.doc([]), openclaw_rc=1, openclaw_msg="cron job disabled", ran="false", reason="disabled")
        self.assertEqual(r.returncode, 1)
        self.assertIn("disabilitato", r.stderr)

    def test_already_running_waits_for_that_run(self):
        r = self.run_script(self.doc([]), ran="false", reason="already-running", openclaw_rc=1)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_run_finished_in_error(self):
        r = self.run_script(self.doc([]), run_status="error")
        self.assertEqual(r.returncode, 1)
        self.assertIn("errore", r.stderr)

    def test_not_started(self):
        r = self.run_script(self.doc([]), ran="false", reason="disabled")
        self.assertEqual(r.returncode, 1)

    def test_verify_fails(self):
        r = self.run_script(self.doc([]), verify_rc=1)
        self.assertEqual(r.returncode, 1)
        self.assertIn("controllo", r.stdout)

    def test_no_faults_section(self):
        r = self.run_script("Nessuna proposta.\nLette: 3 sessioni.\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.board_calls(), [])
        self.assertIn("0 proposte, 0 card", r.stdout)

    def test_missing_folder(self):
        r = self.run_script(self.doc([
            "- Guasto senza casa | /non/esiste/proprio | 29/10 01:00 canale x «frase»",
            f"- Guasto con casa | {self.folder} | 29/10 02:00 canale y «frase»",
        ]))
        self.assertEqual(r.returncode, 1)
        calls = self.board_calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][calls[0].index("--key") + 1], "guasto-guasto-con-casa")
        self.assertIn("cartella inesistente", r.stderr)


if __name__ == "__main__":
    unittest.main()
