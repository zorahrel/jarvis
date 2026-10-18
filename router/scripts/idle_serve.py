"""Serve while someone is asking, exit when nobody is, and let launchd hold the door.

WHY THIS EXISTS. Measured on the owner's Mac on 17/09/2026, with the machine
13 GB oversubscribed (45 GB of footprint asked of 32 GB of RAM, 12 GB in the
compressor, 10 GB of swap): OMEGA had been up for 6 days 3 hours with 0.01% of a
core, zero established connections and 287 MB of footprint, of which only 5.3 MB
were resident - the rest sat compressed or in swap, and every touch of it cost a
disk read. docs-index read the same way at 159 MB. Neither is a daemon in any
useful sense: both answer bursts of requests and then wait for days.

HOW. launchd keeps the listening socket (`Sockets` in the plist) and hands it to
us on start; when we exit because nobody asked anything for a while, the socket
stays open in launchd and the NEXT connection starts the process again. Nothing
is refused and nothing is lost: the client pays one process start, which for
these two is the reload of a SQLite store.

FALLBACK. Run by hand, or by a plist without `Sockets`, `activated_socket()`
returns None and the caller binds the port itself, as before. A server that
cannot find its launchd socket must still work.
"""

from __future__ import annotations

import ctypes
import os
import socket
import time
from ctypes import POINTER, byref, c_char_p, c_int, c_size_t

__all__ = ["activated_socket", "idle_seconds", "serve_until_idle"]

# A request seen this recently keeps the process alive; see serve_until_idle.
DEFAULT_IDLE_S = 900
# How long a single wait for a connection lasts: the idle deadline is checked
# between two waits, so this is also the worst-case overshoot.
POLL_S = 30


def idle_seconds(env_name: str, default: int = DEFAULT_IDLE_S) -> int:
    """Seconds without a request after which the process exits. 0 disables it."""
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


def activated_socket(name: str = "Listeners") -> socket.socket | None:
    """The listening socket launchd holds for this job, or None if we are on our own.

    `launch_activate_socket` lives in libSystem and needs no entitlement. It
    answers with a malloc'd array of descriptors; one listener is all these
    servers have. Any failure means "not started by launchd with a socket",
    which is a normal case (a manual run), not an error.
    """
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        fn = libc.launch_activate_socket
        fn.argtypes = [c_char_p, POINTER(POINTER(c_int)), POINTER(c_size_t)]
        fn.restype = c_int
        fds = POINTER(c_int)()
        count = c_size_t(0)
        if fn(name.encode(), byref(fds), byref(count)) != 0 or count.value < 1:
            return None
        # fromfd dups the descriptor, so the array can be freed right away.
        sock = socket.fromfd(fds[0], socket.AF_INET, socket.SOCK_STREAM)
        for i in range(count.value):
            os.close(fds[i])
        ctypes.CDLL(None).free(fds)
        return sock
    except Exception:
        return None


def adopt(server, sock: socket.socket) -> None:
    """Make an already-built HTTPServer listen on the socket launchd opened.

    The server is built with `bind_and_activate=False`, so it has an unbound
    socket of its own to close before taking this one; `server_name` and
    `server_port` are what `HTTPServer.server_bind` would have set, and the
    handlers read them.
    """
    try:
        server.socket.close()
    except Exception:
        pass
    server.socket = sock
    server.server_address = sock.getsockname()
    host, port = server.server_address[:2]
    server.server_name = socket.getfqdn(host)
    server.server_port = port


def serve_until_idle(server, idle_s: int, log=print) -> None:
    """Answer requests until `idle_s` seconds pass with none in flight and none arriving.

    A request that is still being served never counts as silence: the counter
    is decremented when the worker thread returns, so a long answer cannot be
    cut off by the deadline. `idle_s <= 0` serves forever, which is what a
    manual run or a plist without `Sockets` wants.
    """
    if idle_s <= 0:
        server.serve_forever()
        return

    state = {"inflight": 0, "last": time.monotonic()}
    original = server.process_request_thread

    def counted(request, client_address):
        state["inflight"] += 1
        try:
            original(request, client_address)
        finally:
            state["inflight"] -= 1
            state["last"] = time.monotonic()

    # ThreadingMixIn calls self.process_request_thread, so an instance
    # attribute is enough and no subclass is needed.
    server.process_request_thread = counted
    server.timeout = min(POLL_S, idle_s)

    while True:
        server.handle_request()
        if state["inflight"] == 0 and time.monotonic() - state["last"] >= idle_s:
            break
    log(f"idle for {idle_s}s: exiting, launchd keeps the port and will start me again", flush=True)
