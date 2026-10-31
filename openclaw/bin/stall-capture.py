#!/usr/bin/env python3
"""Salva il contesto di ogni "stalled session ... blocked_tool_call" in ~/.openclaw/logs/stalls/.

Chiamato da mailwatch ogni minuto. Per ogni sessione bloccata scrive UN file datato con le
righe MCP/cli-backend e quelle della sessione prima dello stall: serve a trovare perché la
risposta di un tool non torna. Il log contiene mail: i file restano locali.
Uso: stall-capture.py [--log FILE] [--out DIR] [--state FILE]
"""
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CONTEXT_LINES = 400  # righe del log prima dello stall da cercare
KEEP = ("mcp-loopback", "cli-backend", "cli turn", "cli exec")


def arg(name, default):
    return Path(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def line_text(raw):
    try:
        d = json.loads(raw)
    except ValueError:
        return raw.rstrip()
    return " ".join(str(d.get(k)) for k in ("0", "1", "2") if d.get(k) is not None)


def live_state():
    """Fotografia al momento della cattura: chi ha byte fermi nei socket locali (Recv-Q/Send-Q > 0)
    e in che stato sono i processi claude. Recv-Q > 0 lato claude = claude bloccato con la risposta
    gia' arrivata; nessun socket = problema di trasporto (analisi oracle 21/10)."""
    def run(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.TimeoutExpired) as e:
            return f"{cmd[0]}: {e}"
    socks = [l for l in run(["netstat", "-anv", "-p", "tcp"]).splitlines()
             if "127.0.0.1" in l and re.match(r"tcp4\s+(\d+)\s+(\d+)", l)
             and any(int(n) for n in re.match(r"tcp4\s+(\d+)\s+(\d+)", l).groups())]
    procs = [l for l in run(["ps", "-axo", "pid,stat,etime,%cpu,command"]).splitlines()
             if "openclaw-cli-mcp" in l]
    return ["== SOCKET LOCALI CON CODA ==", *(socks or ["(nessuno)"]),
            "== PROCESSI claude di OpenClaw ==", *[l[:220] for l in procs]]


def main():
    log = arg("--log", Path(f"/tmp/openclaw/openclaw-{datetime.now():%Y-%m-%d}.log"))
    out = arg("--out", HOME / ".openclaw/logs/stalls")
    state = arg("--state", out / ".seen")
    if not log.exists():
        return
    out.mkdir(parents=True, exist_ok=True)
    seen = set(state.read_text().split()) if state.exists() else set()
    lines = log.read_text(errors="replace").splitlines()
    new = []
    for i, raw in enumerate(lines):
        if "stalled session" not in raw or "blocked_tool_call" not in raw:
            continue
        m = re.search(r"sessionId=(\S+) .*?activeToolCallId=(\S+)", line_text(raw))
        if not m or m.group(2) in seen:
            continue
        session, call = m.group(1), m.group(2)
        key = re.search(r"sessionKey=(\S+)", line_text(raw))
        key = key.group(1) if key else ""
        ctx = [line_text(r) for r in lines[max(0, i - CONTEXT_LINES):i]]
        ctx = [c for c in ctx if call in c or session in c or key in c or any(k in c for k in KEEP)]
        name = f"{datetime.now():%Y%m%d-%H%M%S}-{session[:8]}-{call[-6:]}.log"
        (out / name).write_text("\n".join(ctx[-150:] + ["== STALL ==", line_text(raw)] + live_state()) + "\n")
        seen.add(call)
        new.append(name)
    state.write_text("\n".join(sorted(seen)) + "\n")
    for n in new:
        print(f"stall salvato: {n}")


if __name__ == "__main__":
    main()
