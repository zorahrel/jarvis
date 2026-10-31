#!/usr/bin/env python3
"""Barra di gws-login-watch: una cartella senza login apre UNA voce, il login che torna la chiude. Hub finto, mai quello vero."""
import json
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
open_items, posts = [], []


class Hub(BaseHTTPRequestHandler):
    def do_GET(self):
        self._send({"items": open_items})

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        posts.append(b)
        if b.get("kind") == "chiudi":
            open_items[:] = [v for v in open_items if v["id"] != b["ref"]]
        else:
            open_items.append({**b, "id": "v%d" % len(posts)})
        self._send({"ok": True})

    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), Hub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
root = Path(tempfile.mkdtemp())
(root / "gws-vivo").mkdir(); (root / "gws-vivo" / "credentials.enc").write_text("x")
(root / "gws-morto").mkdir()
(root / "gws-armonia-backup.txt").write_text("non è una cartella")


def run():
    return subprocess.run([sys.executable, str(HERE / "gws-login-watch"), "--root", str(root), "--hub", "http://127.0.0.1:%d" % srv.server_port],
                          capture_output=True, text=True, check=True).stdout


fails = []
def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond: fails.append(name)

run(); run()
check("una sola voce per la cartella senza login, anche a due giri", [p.get("key") for p in posts] == ["gws-login-morto"])
check("la voce dice il comando per rifare il login", "gws-mail morto auth login" in posts[0]["why"])
(root / "gws-morto" / "credentials.enc").write_text("x")
run()
check("login tornato: la voce si chiude", posts[-1] == {"kind": "chiudi", "ref": "v1", "by": "gws-login-watch", "note": "login tornato"} and not open_items)
sys.exit(1 if fails else 0)
