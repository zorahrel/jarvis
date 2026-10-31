#!/usr/bin/env python3
"""Barra di board-card --chiudi: --vista vuole --chiede e mette la riga «aspetta: attilio» in testa alla descrizione.
Topics finto in locale (http), nessuna card vera. uso: python3 scripts/board-card-test.py (exit 0 = verde)"""
import json, os, subprocess, sys, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

CARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board-card")
store = {}   # id -> {"projectId", "description", "status", "parentTaskId"}
log = []     # (method, path, body)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        self._send({"task": {"id": self.path.rsplit("/", 1)[1], **store[self.path.rsplit("/", 1)[1]]}})

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")

    def do_POST(self):
        log.append(("POST", self.path, self._body())); self._send({})

    def do_PATCH(self):
        body = self._body(); log.append(("PATCH", self.path, body))
        store[self.path.rsplit("/", 1)[1]].update(body); self._send({})


def run(*args, card="c1"):
    env = {**os.environ, "TOPICS_URL": f"http://127.0.0.1:{srv.server_port}", "BOARD_CARD_TOKEN": "t"}
    return subprocess.run([sys.executable, CARD, "--chiudi", card, "--prova", "node --test → exit 0", *args], env=env, capture_output=True, text=True)


class T(unittest.TestCase):
    def setUp(self):
        store.clear(); log.clear()
        store["c1"] = {"projectId": "b", "description": "Lavoro finito.", "status": "in_progress", "parentTaskId": None}

    def test_vista_senza_chiede_rifiuta_e_non_scrive(self):
        r = run("--vista")
        self.assertNotEqual(r.returncode, 0); self.assertIn("--chiede", r.stderr)
        self.assertEqual(log, [])
        self.assertEqual(store["c1"]["status"], "in_progress")

    def test_vista_con_chiede_mette_la_riga_in_testa_e_va_in_review(self):
        r = run("--vista", "--chiede", "il menu ti sembra giusto?")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(store["c1"]["status"], "review")
        self.assertTrue(store["c1"]["description"].startswith("aspetta: attilio — il menu ti sembra giusto?\n\nLavoro finito."))

    def test_la_riga_c_e_gia_non_si_raddoppia(self):
        store["c1"]["description"] = "aspetta: attilio — ok all'invio?\n\nresto"
        self.assertEqual(run("--vista", "--chiede", "altra domanda lunga").returncode, 0)
        self.assertEqual(store["c1"]["description"].count("aspetta: attilio"), 1)
        self.assertEqual(store["c1"]["status"], "review")

    def test_senza_vista_chiude_in_done_senza_toccare_la_descrizione(self):
        self.assertEqual(run().returncode, 0)
        self.assertEqual(store["c1"]["status"], "done"); self.assertEqual(store["c1"]["description"], "Lavoro finito.")

    def test_chiede_senza_vista_rifiuta(self):
        self.assertNotEqual(run("--chiede", "una domanda qualunque").returncode, 0)
        self.assertEqual(log, [])


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
if __name__ == "__main__":
    res = unittest.main(exit=False, argv=[sys.argv[0]]).result
    srv.shutdown()
    sys.exit(0 if res.wasSuccessful() else 1)
