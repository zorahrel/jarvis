#!/usr/bin/env python3
"""Suite della classe «resto» di devreap, tutta finta: tabella ps, responsabili,
cwd, output, rete, scripts.json e DB di Topics, registro delle sessioni Claude.

Qui si finge tutto perche' la regola decide su fatti del kernel che con un
processo vero non si fabbricano (un responsabile morto, un pid riciclato, una
sessione chiusa) e perche' il Mac non ha memoria per una suite di processi veri.
L'altra suite, devreap-test.sh, resta quella con i processi veri.

Il kernel finto si comporta come quello vero, misurato il 25/10: un responsabile
morto non si vede mai (il processo diventa responsabile di se' stesso, un pid morto
non torna), e FakeProbe lo fa rispettare. La premessa e' provata una volta sul kernel
vero (processi veri, un responsabile che muore) prima dei finti.

In fondo le mutazioni: ognuna toglie una delle protezioni (l'obbligo del padrone
morto, i veti, la memoria dei lanciatori, i socket unix, i terminali parcheggiati,
l'ora di partenza dei comandi Topics, le cartelle TCC, il contratto del --list, le
esclusioni dei processi staccati apposta: E1-E7) e la suite deve diventare rossa per ciascuna.

    python3 devreap-resto-test.py        exit 0 = verde e tutti i mutanti presi
"""
import contextlib
import ctypes
import signal
import subprocess
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

SRC = Path(__file__).resolve().parent / "devreap"
UID, NOW, H = 501, time.time(), 3600
# Ogni mutante rimette il codice come prima di una correzione: deve uscire almeno un rosso.
MUTATIONS = [
    ("padrone morto non obbligatorio",
     "        if not why:                          # padrone vivo o ignoto",
     "        why = why or 'mutante'\n        if not why:  # padrone vivo o ignoto"),
    ("responsabile di se' stesso = padrone morto, anche se mai visto figlio di una sessione",
     "    launcher = memory.launcher_of(root, procs) if resp == root and procs[root][\"ppid\"] == 1 else None",
     "    launcher = '999@1' if resp == root else None"),
    ("la memoria dei lanciatori non registra mai",
     "        self.kids, self.sids = alive, {k: v for k, v in sids.items() if k in alive}\n", "        pass\n"),
    ("lanciatore vivo per solo pid (pid riciclato)",
     "if int(lpid) in procs and str(procs[int(lpid)][\"start\"]) == lstart:", "if int(lpid) in procs:"),
    ("TCC solo su Documents",
     "for d in (\"Desktop\", \"Documents\", \"Downloads\"))", "for d in (\"Documents\",))"),
    ("TCC senza lo slash finale (Documents-vecchi sarebbe protetta)",
     "return (path + \"/\").startswith(TCC_DIRS)", "return path.startswith(TCC_DIRS)"),
    ("la memoria registra anche i figli di un'app ospite",
     "            if kinds[resp] == \"owner\":", "            if True:"),
    ("resto_candidates non guarda chi ha ancora un responsabile",
     "    memory.observe(procs, probe, owners, uid)\n", "    pass\n"),
    ("il CLI morto basta: la sessione ripresa con un CLI nuovo non conta",
     "        if lsid and owners.session_alive(lsid) is not False:\n            return None\n",
     ""),
    ("sessione del lanciatore mai registrata",
     "                sid = owners.pid_session.get(resp)\n", "                sid = None\n"),
    ("il lanciatore ancora vivo non e' un veto",
     "if int(lpid) in procs and str(procs[int(lpid)][\"start\"]) == lstart:\n            return None",
     "if False:\n            return None"),
    ("memoria cercata per pid senza l'ora di partenza (pid riciclato)",
     "return self.kids.get(self.key(pid, procs))",
     "return next((v for k, v in self.kids.items() if k.partition('@')[0] == str(pid)), None)"),
    ("comando Topics riconosciuto senza l'ora di partenza (pid riciclato)",
     "if pid in members and same_start(lstart, procs[pid][\"start\"]):", "if pid in members:"),
    ("«finito» di Topics da solo vale la chiusura immediata sulla rete",
     "if not r.get(\"weak\") and any(n[2] for n in nets)", "if any(n[2] for n in nets)"),
    ("isdir su una cartella TCC",
     "(not tcc_protected(cwd) and not os.path.isdir(cwd))", "not os.path.isdir(cwd)"),
    ("stat su un log in cartella TCC",
     "if any(tcc_protected(p) for p in r[\"outputs\"]):", "if False:"),
    ("client sui socket unix ignorati",
     "if sum(n[1] for n in nets) + unix:", "if sum(n[1] for n in nets):"),
    ("via il veto della sessione viva dentro l'albero",
     "if any(p in owners.session_pids for p in members):\n        return None",
     "if False:\n        return None"),
    ("terminale parcheggiato = chiuso (comandi)",
     "\"SELECT 1 FROM terminal_sessions WHERE id = ?\"",
     "\"SELECT 1 FROM terminal_sessions WHERE id = ? AND status = 'active'\""),
    ("terminale parcheggiato = chiuso (sessioni e scratchpad)",
     "\"SELECT 1 FROM terminal_sessions WHERE claude_session_id = ?\"",
     "\"SELECT 1 FROM terminal_sessions WHERE claude_session_id = ? AND status = 'active'\""),
    ("comando Topics finito trattato come in corsa",
     "finished = bool(cmd_owner) and cmd_owner[2]", "finished = False"),
    ("M1 sessione ignota = morta",
     "    if sid and owners.session_alive(sid) is not False:\n        return None",
     "    if sid and owners.session_alive(sid) is True:\n        return None"),
    ("M2 comando Topics ignoto = chiuso",
     "if cmd_owner and not finished and cmd_owner[1] is not False:",
     "if cmd_owner and not finished and cmd_owner[1] is True:"),
    ("M3 responsabile sessione viva non e' un padrone",
     "    if resp in owners.session_pids:\n        return \"owner\"\n", ""),
    ("M4 responsabile demone vivo non e' un padrone",
     "return \"host\" if is_app(probe.exe(resp) or procs[resp][\"cmd\"]) else \"owner\"",
     "return \"host\""),
    ("M7 kernel muto = padrone morto",
     "    if resp <= 0:\n        return None", "    if resp <= 0:\n        return 'kernel muto'"),
    ("--list senza «osservo» in sola osservazione",
     "if not kill and not verdict.startswith(\"in uso\"):", "if False:"),
    ("le sessioni dei lanciatori non si rileggono dal file di stato",
     'memory = RespMemory(data.get("kids"), data.get("sids"))', 'memory = RespMemory(data.get("kids"))'),
    ("le sessioni dei lanciatori non si scrivono nel file di stato",
     '"sids": memory.dump_sids(),', ''),
    ("E1 il tunnel ssh -N non e' escluso",
     're.compile(r"(?:^|/)ssh\s', 're.compile(r"(?!)(?:^|/)ssh\s'),
    ("E2 il demone di 1Password non e' escluso",
     're.compile(r"(?:^|/)op\s+daemon', 're.compile(r"(?!)(?:^|/)op\s+daemon'),
    ("E3 l'involucro dei terminali Topics non e' escluso",
     're.compile(r"_topics_group_has_peers|topics-command-group")', 're.compile(r"(?!)")'),
    ("E4 la cartella dei terminali Topics non e' esclusa",
     're.compile(r"^/(?:private/)?var/folders', 're.compile(r"(?!)^/(?:private/)?var/folders'),
    ("E5 il lanciatore di job dell'hub non e' escluso",
     're.compile(r"\\$EXIT_FILE', 're.compile(r"(?!)\\$EXIT_FILE'),
    ("E6 le esclusioni non si applicano",
     'if resto_escluso(info["cmd"], probe.cwd(pid)):', 'if False:'),
    ("E7 ssh -fN unito non escluso (vale solo -N da solo)",
     '-[A-Za-z]*[fN][A-Za-z]*', '-N'),
    ("E8 ssh -f da solo non escluso (solo -N)",
     '-[A-Za-z]*[fN][A-Za-z]*', '-[A-Za-z]*N[A-Za-z]*'),
    ("la sola osservazione che chiude lo stesso",
     # con la riga dopo: da c79fadb la stessa riga c'e' anche nella classe tsserver
     "kill = RESTO_KILL and not dry\n    keys = [", "kill = not dry\n    keys = ["),
]
CONTRACT = re.compile(r"^  resto pid=\d+ albero=\d+ fp=\d+MB eta=\d+m \S.* -> "
                      r"(si chiude ora|aspetta|in uso|osservo)")

LIVE_SID = "11111111-1111-4111-8111-111111111111"   # sessione nel registro
CHAT_SID = "22222222-2222-4222-8222-222222222222"   # chat di Topics aperta
DEAD_SID = "33333333-3333-4333-8333-333333333333"   # nessuno la conosce piu'
REUSED_SID = "44444444-4444-4444-8444-444444444444"  # file rimasto, pid riciclato
INNER_SID = "55555555-5555-4555-8555-555555555555"   # sessione viva dentro un albero
DORM_SID = "66666666-6666-4666-8666-666666666666"    # terminale Topics parcheggiato
JCODE_EXE = "/Users/x/.jcode/builds/shared-server/jcode"
# `lsof -U -F dn` del ponte dei terminali di Topics il 25/10: in ascolto (fd 3), una
# coppia interna (fd 4-5) e la connessione accettata dal server di Topics (fd 6-7).
BRIDGE_LSOF = """p85176
f3
d0xf1400fc185235e35
n/tmp/topics-pty-bridge-9ec57b11.sock
f4
d0xc3c2a0ea2dbb8920
n->0x3e8dfe7ef199f0ba
f5
d0x3e8dfe7ef199f0ba
n->0xc3c2a0ea2dbb8920
f6
d0x2e744f11a4249d92
n/tmp/topics-pty-bridge-9ec57b11.sock
f7
d0x2e744f11a4249d92
n/tmp/topics-pty-bridge-9ec57b11.sock
"""
CLAUDE_EXE = "/Users/x/Library/Application Support/Claude/claude-code/2/claude.app/Contents/MacOS/claude"
HOST_EXE = "/Users/x/Applications/Topics Host.app/Contents/MacOS/topics-host"
PY_EXE = "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python"


def load(text=None):
    os.environ.pop("DEVREAP_ONLY_PATH", None)        # il recinto qui non serve
    os.environ.pop("DEVREAP_RESTO_IDLE", None)
    os.environ.pop("DEVREAP_RESTO_KILL", None)       # la suite prova il default: osservazione
    loader = importlib.machinery.SourceFileLoader("devreap_ut", str(SRC))
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("devreap_ut", loader))
    if text is None:
        loader.exec_module(mod)
    else:
        exec(compile(text, str(SRC), "exec"), mod.__dict__)
    return mod


def lstart(epoch):
    return time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(epoch))


def proc(ppid, cmd, age, uid=UID):
    start = int(NOW - age)
    return {"ppid": ppid, "uid": uid, "cpu": 0.0, "age": int(age),
            "lstart": lstart(start), "start": start, "cmd": cmd}


class FakeProbe:
    def __init__(self, resp, exe, cwd, outputs, net, launchd, unix=None):
        self._resp, self._exe, self._cwd = resp, exe, cwd
        self._out, self._net, self._launchd = outputs, net, launchd
        self._unix = unix or {}
        self.procs = {}                  # la tabella ps del mondo finto, la mette world()

    def unix_clients(self, pids):
        return sum(self._unix.get(pid, 0) for pid in pids)

    def responsible(self, pid):
        r = self._resp.get(pid, pid)
        # Il kernel vero (misurato 25/10): o il processo stesso, o un responsabile vivo, o
        # -1 se non risponde. Mai un pid morto o riciclato: un fixture che lo fa dice il falso.
        if r > 0 and r != pid and r not in self.procs:
            raise AssertionError(f"fixture impossibile: responsabile {r} di {pid} e' morto")
        return r

    def exe(self, pid):
        return self._exe.get(pid, "/opt/homebrew/bin/node")

    def cwd(self, pid):
        return self._cwd[pid]

    def outputs(self, pids):
        return [p for pid in pids for p in self._out.get(pid, [])]

    def net(self, pid):
        return self._net.get(pid, (set(), 0, False))

    def launchd_pids(self):
        return set(self._launchd)


def world(tmp, mod):
    """Un Mac finto: ogni radice e' un caso, con il suo verdetto atteso."""
    exists = tmp / "progetto"
    exists.mkdir()
    gone = tmp / "cancellata"                       # cwd di un processo, poi rimossa
    sess = lambda sid: f"/private/tmp/claude-501/-Users-x-Projects-sito/{sid}/scratchpad"
    old_log, new_log = tmp / "vecchio.log", tmp / "nuovo.log"
    old_log.write_text("x")
    new_log.write_text("x")
    os.utime(old_log, (NOW - 3 * H, NOW - 3 * H))
    os.utime(new_log, (NOW - 600, NOW - 600))

    procs = {
        700: proc(699, CLAUDE_EXE, 9 * H),            # CLI vivo di LIVE_SID
        701: proc(1, "/opt/homebrew/bin/node nuovo.js", 0.5 * H),   # pid riciclato
        702: proc(699, CLAUDE_EXE, 1 * H),            # registro con procStart sbagliato
        800: proc(1, HOST_EXE, 30 * H),               # app ospite (Topics Host)
        900: proc(1, f"{JCODE_EXE} serve", 50 * H),   # demone vivo, non un'app
    }
    resp, exe, outs, net = {}, {700: CLAUDE_EXE, 702: CLAUDE_EXE, 800: HOST_EXE, 900: JCODE_EXE}, {}, {}
    cwd = {701: str(exists), 800: str(exists), 900: str(exists)}
    unix = {}
    expect = {}                                     # pid -> (passata1, finale, perche')
    # Il kernel vero: un processo il cui responsabile e' morto e' responsabile di se' stesso
    # (resp[pid] non c'e'). Quello che lo distingue da uno nato staccato e' la memoria: di
    # default l'abbiamo visto figlio della sessione 999, che ora non c'e' piu'. seen=None =
    # mai visto (nato staccato, o orfano prima del primo giro), seen="host" = era figlio
    # di un'app ospite (non si registra, vedi RespMemory), seen="riciclato" = la memoria
    # e' di un altro processo che aveva lo stesso pid.
    long_ago = int(NOW - 40 * H)
    memory = mod.RespMemory()
    probe_procs = procs

    def case(pid, want_first, want_final, why, cmd="bun waitprod.ts", age=5 * H,
             r=None, c=None, e=None, o=None, n=None, uid=UID, u=0, seen="auto", launcher=None):
        procs[pid] = proc(1, cmd, age, uid)
        if r is not None:
            resp[pid] = r
        if seen == "auto":                   # responsabile di se': l'abbiamo visto figlio di 999
            seen = "owner" if r is None else None
        if seen == "owner":
            memory.kids[f"{pid}@{procs[pid]['start']}"] = launcher or f"999@{long_ago}"
        elif seen == "riciclato":
            memory.kids[f"{pid}@{long_ago}"] = f"999@{long_ago}"
        cwd[pid] = c if c is not None else str(exists)
        if e:
            exe[pid] = e
        if o:
            outs[pid] = o
        if n is not None:
            net[pid] = n
        unix[pid] = u
        expect[pid] = (want_first, want_final, why)

    case(100, False, False, "padrone vivo (sessione Claude nel registro)", r=700)
    case(110, False, True, "padrone morto e fermo da 2 ore")
    procs[1100] = proc(110, "node figlio.js", 5 * H)        # figlio: va nell'albero
    case(111, False, False, "padrone morto ma nato da 30 minuti", age=0.5 * H)
    case(120, False, False, "job launchd")
    case(130, False, False, "app", cmd="/Applications/Foo.app/Contents/MacOS/Foo",
         e="/Applications/Foo.app/Contents/MacOS/Foo")
    case(131, False, True, "Python.app di un framework non e' un'app",
         cmd=f"{PY_EXE} -m http.server 4000 --bind 127.0.0.1", e=PY_EXE,
         n=({"4000"}, 0, False))
    case(140, True, True, "http.server su 0.0.0.0 con padrone morto: subito",
         cmd=f"{PY_EXE} -m http.server 8777", e=PY_EXE, age=60, n=({"8777"}, 0, True))
    case(141, False, False, "http.server su 0.0.0.0 ma padrone vivo",
         cmd=f"{PY_EXE} -m http.server 8778", e=PY_EXE, r=700, n=({"8778"}, 0, True))
    case(150, False, False, "padrone morto ma con un client", n=({"4444"}, 1, False))
    case(160, False, True, "cartella cancellata (ospite vivo)", r=800, c=str(gone))
    case(161, False, True, "cartella nel Cestino", r=800, c=mod.TRASH + "vecchio")
    case(162, False, False, "solo l'ospite vivo: nessun indizio", r=800)
    case(170, False, True, "comando di Topics, topic archiviata", r=800)
    case(171, False, False, "comando di Topics aperto, anche con cartella cancellata",
         r=800, c=str(gone))
    case(172, False, True, "comando di un terminale Topics chiuso", r=800)
    case(180, False, True, "scratchpad di una sessione chiusa", r=800, c=sess(DEAD_SID))
    case(181, False, False, "scratchpad di una sessione viva (procStart in UTC)",
         c=sess(LIVE_SID))
    case(182, False, False, "scratchpad di una chat Topics aperta, CLI morto",
         c=sess(CHAT_SID))
    case(183, False, True, "registro rimasto ma pid riciclato", r=702, c=sess(REUSED_SID))
    case(190, False, False, "responsabile di se' (jcode serve)", r=190, seen=None)
    case(191, False, False, "la memoria e' di un altro processo con lo stesso pid", seen="riciclato")
    case(193, False, False, "log scritto 10 minuti fa", o=[str(new_log)])
    case(194, False, True, "log fermo da 3 ore", o=[str(old_log)])
    case(195, False, False, "scrive nei task di una sessione viva",
         o=[f"/private/tmp/claude-501/-Users-x-Projects-sito/{LIVE_SID}/tasks/b1.output"])
    case(196, False, False, "processo di un altro utente", uid=0)
    case(197, False, False, "eseguibile di sistema", e="/usr/libexec/qualcosa")
    case(198, False, False, "lsof muto: la passata non conta", n=None)
    net[198] = None
    # Verifica del 25/10: il riavvio di Topics Host, i veti scoperti dai mutanti, i
    # terminali parcheggiati e i comandi sopravvissuti alla loro corsa.
    case(163, False, False, "responsabile morto ma era l'app ospite (riavvio di Topics Host)", seen="host")
    case(164, False, False, "responsabile di se' stesso, mai visto figlio di nessuno", seen=None)
    case(165, False, False, "padrone morto ma un client sul socket unix (il ponte)", u=1)
    case(166, False, False, "una sessione Claude viva dentro l'albero")
    procs[1660] = proc(166, CLAUDE_EXE, 4 * H)
    exe[1660] = CLAUDE_EXE
    case(167, False, False, "responsabile sessione viva, cartella cancellata", r=700, c=str(gone))
    case(168, False, False, "responsabile demone vivo (jcode serve), cartella cancellata",
         r=900, c=str(gone))
    case(169, False, False, "kernel muto sul responsabile, cartella cancellata", r=0, c=str(gone))
    case(173, False, False, "comando di un terminale Topics parcheggiato (dormant)", r=800)
    case(174, False, True, "comando Topics finito ma vivo, topic aperta: fermo, si chiude dopo l'attesa",
         r=800, seen=None)
    # Il «finito» di Topics da solo e' debole (un falso morto al boot sotto swap): niente
    # chiusura immediata, serve anche l'attesa. Con un padrone morto visto, invece, subito.
    case(142, False, True, "http.server su * da un comando Topics finito, topic aperta (:8777): aspetta",
         cmd=f"{PY_EXE} -m http.server 8777", e=PY_EXE, r=800, n=({"8777"}, 0, True), seen=None)
    case(143, False, False, "comando Topics finito ma vivo, con un client", r=800, seen=None,
         n=({"5000"}, 1, False))
    case(144, False, False, "comando Topics finito ma vivo, log scritto 10 minuti fa", r=800,
         seen=None, o=[str(new_log)])
    case(145, False, False, "http.server su * da un comando Topics finito ma con un client",
         cmd=f"{PY_EXE} -m http.server 8779", e=PY_EXE, r=800, n=({"8779"}, 1, True), seen=None)
    # Pid riciclato: le voci recent di Topics restano 7 giorni, i pid girano in ~40 minuti.
    case(175, False, False, "comando Topics finito di un altro processo (pid riciclato)", r=800,
         seen=None)
    case(176, False, False, "comando Topics in corsa di un altro processo (pid riciclato), topic chiusa",
         r=800, seen=None)
    case(149, False, False, "il kernel dice «di se' stesso» ma chi l'ha lanciato e' ancora vivo",
         seen="owner", launcher=f"700@{procs[700]['start']}")
    DOCS = str(Path.home() / "Documents" / "fantasma-devreap-test")
    case(147, False, False, "cwd in Documents: non si tocca, nessun indizio", seen=None, c=DOCS)
    case(148, False, False, "padrone morto ma il log sta in Documents: non si guarda, aspetta",
         o=[DOCS + "/server.log"])
    case(184, False, False, "scratchpad di un terminale Topics parcheggiato", r=800,
         c=sess(DORM_SID))
    # Staccati apposta (RESTO_ESCLUSI): i quattro casi che il registro dell'osservazione ha mostrato
    # come chiusure sbagliate, copiati da devreap.log (comando e cartella come li ha visti il
    # giro vero), piu' il lanciatore di job dell'hub. Restano vivi anche con padrone morto e fermi da ore.
    TT = "/private/var/folders/d8/0rlg1q2x64gbx_cn5y2qjf8w0000gn/T/topics-tt-"
    WRAP = ("/bin/zsh -c _topics_group_has_peers() {\n  _topics_fifo=\"${TMPDIR:-/tmp}/topics-command-group-$$\"\n"
            "  while ! mkfifo ")
    case(210, False, False, "26/10 02:48 involucro di un terminale Topics, cartella cancellata",
         cmd=WRAP, r=800, c=TT + "bmaxNq/topics-cmd-project-xVTUwd", age=124 * 60)
    case(211, False, False, "26/10 13:23 involucro di un terminale Topics, padrone morto dopo il riavvio",
         cmd=WRAP, c=TT + "ArKoGF/topics-cmd-project-qSDtJa", age=139 * 60)
    procs[2111] = proc(211, "sleep 1000", 139 * 60)
    case(212, False, False, "27/10 03:11 tunnel ssh -f -N di un progetto fatto per restare staccato",
         cmd="ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o SetEnv=TUNNEL=recover-api-tunnel "
             "-L 127.0.0.1:39850:1", e="/usr/bin/ssh", age=141 * 60,
         c="/Users/zorahrel/Projects/sito-wt-standard/api")
    case(213, False, False, "27/10 05:46 il demone di 1Password",
         cmd="op daemon", e="/opt/homebrew/bin/op", age=157 * 60,
         c="/Users/zorahrel/.openclaw/tmp/com.agilebits.op.501")
    case(214, False, False, "26/10 04:53 lanciatore di job dell'hub con 8 figli",
         cmd='sh -c "$0" "$@"; c=$?; echo "$c" > "$EXIT_FILE"; echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] '
             '$JOB_ID exit $c" >> "$JOB_LOG"', age=228 * 60)
    for k in range(8):
        procs[2140 + k] = proc(214, "node job.js", 228 * 60)
    case(215, False, False, "solo la cartella: un comando qualunque sotto topics-tt-",
         cmd="bun serve.ts", c=TT + "zzzzzz/x")
    case(216, False, False, "solo il comando: involucro Topics con una cartella normale",
         cmd=WRAP)
    case(217, False, False, "ssh -fN con le opzioni unite", cmd="ssh -fN -L 1:2:3 host", e="/usr/bin/ssh")
    # Controlli: la stessa forma senza la caratteristica che esclude si chiude come prima.
    case(218, False, True, "controllo: ssh senza -f ne' -N si chiude", cmd="ssh -L 127.0.0.1:1:1:1 host",
         e="/usr/bin/ssh")
    case(230, False, False, "ssh -f senza -N (tunnel staccato con -f) escluso", cmd="ssh -f -L 1:2:3 host",
         e="/usr/bin/ssh")
    case(219, False, True, "controllo: op che non e' il demone si chiude", cmd="op run -- node x.js",
         e="/opt/homebrew/bin/op")
    case(220, False, True, "controllo: sh -c con altro dentro si chiude", cmd='sh -c "$0" "$@"; echo fine')
    case(221, False, True, "controllo: una cartella T/ che non e' dei terminali Topics si chiude",
         cmd="bun serve.ts", c="/private/var/folders/d8/0rl/T/altra-cosa/x")
    gone.mkdir()
    gone.rmdir()                                    # come un rm -rf dopo il lavoro

    # Il registro delle sessioni Claude vive: procStart in UTC, come lo scrive Claude.
    sessions = tmp / "sessions"
    sessions.mkdir()
    utc = lambda pid: time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime(procs[pid]["start"]))
    (sessions / "700.json").write_text(json.dumps(
        {"pid": 700, "sessionId": LIVE_SID, "procStart": utc(700)}))
    (sessions / "702.json").write_text(json.dumps(
        {"pid": 702, "sessionId": REUSED_SID, "procStart": "Mon Jan 05 10:00:00 2026"}))
    (sessions / "1660.json").write_text(json.dumps(
        {"pid": 1660, "sessionId": INNER_SID, "procStart": utc(1660)}))
    (sessions / "rotto.json").write_text("{")

    scripts = tmp / "scripts.json"
    scripts.write_text(json.dumps({"running": [
        {"pid": 170, "pidLstart": procs[170]["lstart"], "cmd": {"sessionKey": "topic:chiusa"}},
        {"pid": 171, "pidLstart": procs[171]["lstart"], "cmd": {"sessionKey": "topic:aperta"}},
        {"pid": 173, "pidLstart": procs[173]["lstart"], "cmd": {"sessionKey": "term-parcheggiato"}},
        {"pid": 176, "pidLstart": lstart(NOW - 7 * 24 * H), "cmd": {"sessionKey": "topic:chiusa"}},
    ], "recent": [
        {"pid": 172, "pidLstart": procs[172]["lstart"], "status": "error",
         "cmd": {"sessionKey": "fe407bad-c890-4b20-b7ac-0f1d4ee85e22", "topicId": None}},
        {"pid": 174, "pidLstart": procs[174]["lstart"], "status": "done",
         "cmd": {"sessionKey": "topic:aperta"}},
        {"pid": 142, "pidLstart": procs[142]["lstart"], "status": "error",
         "cmd": {"sessionKey": "topic:aperta"}},
        {"pid": 143, "pidLstart": procs[143]["lstart"], "status": "done",
         "cmd": {"sessionKey": "topic:aperta"}},
        {"pid": 144, "pidLstart": procs[144]["lstart"], "status": "done",
         "cmd": {"sessionKey": "topic:aperta"}},
        {"pid": 145, "pidLstart": procs[145]["lstart"], "status": "done",
         "cmd": {"sessionKey": "topic:aperta"}},
        # Il pid e' stato riciclato: la voce e' di un processo di una settimana fa.
        {"pid": 175, "pidLstart": lstart(NOW - 7 * 24 * H), "status": "done",
         "cmd": {"sessionKey": "topic:aperta"}},
    ]}))

    db = tmp / "topics.db"
    con = sqlite3.connect(db)
    con.executescript("""
        CREATE TABLE topics (session_key TEXT, archived INTEGER);
        CREATE TABLE terminal_sessions (id TEXT, status TEXT, claude_session_id TEXT);
        CREATE TABLE claude_code_sessions (session_key TEXT, claude_session_id TEXT);
        INSERT INTO topics VALUES ('topic:chiusa', 1), ('topic:aperta', 0), ('topic:chat', 0);
    """)
    con.execute("INSERT INTO claude_code_sessions VALUES ('topic:chat', ?)", (CHAT_SID,))
    # Terminali parcheggiati da Topics: la tab e' aperta, la PTY no.
    con.execute("INSERT INTO terminal_sessions VALUES ('term-parcheggiato', 'dormant', NULL)")
    con.execute("INSERT INTO terminal_sessions VALUES ('term-2', 'dormant', ?)", (DORM_SID,))
    con.commit()
    con.close()

    probe = FakeProbe(resp, exe, cwd, outs, net, launchd={120}, unix=unix)
    probe.procs = procs
    owners = mod.Owners(procs, sessions=sessions, scripts=scripts, db=db)
    return procs, probe, owners, expect, memory


TCC = tuple(str(Path.home() / d) + "/" for d in ("Desktop", "Documents", "Downloads"))


def run(mod, real=False):
    """Le asserzioni. Ritorna il numero di fallimenti. real=True prova anche il kernel vero."""
    fails = [0]

    def check(ok, label):
        print(f"  {'ok  ' if ok else 'FAIL'} {label}")
        fails[0] += not ok

    # Nessuno stat su Desktop, Documenti e Download: sul Mac vero fa comparire la richiesta
    # TCC in primo piano. Il ragno registra, poi delega.
    touched, real_stat = [], os.stat

    def spy(path, *a, **k):
        if isinstance(path, (str, bytes, os.PathLike)) and (os.fsdecode(path) + "/").startswith(TCC):
            touched.append(os.fsdecode(path))
        return real_stat(path, *a, **k)

    os.stat = spy
    try:
        _run(mod, check, touched, real)
    finally:
        os.stat = real_stat
    return fails[0]


def _run(mod, check, touched, real):
    with tempfile.TemporaryDirectory() as t:
        procs, probe, owners, expect, memory = world(Path(t), mod)
        times = (NOW - 2 * H - 60, NOW - H, NOW)    # 3 passate che coprono 2 ore
        state, reaped = {}, []
        for when in times:
            rows = mod.resto_candidates(procs, probe, owners, UID, memory=memory)
            reap, state, report = mod.resto_decide(rows, procs, probe, state, when)
            reaped.append({r["root"]: r for r in reap})
        for pid, (first, final, why) in sorted(expect.items()):
            got = (pid in reaped[0], pid in reaped[-1])
            check(got == (first, final), f"{pid} {why}: chiuso alla 1a {got[0]}, alla 3a {got[1]}")
        if 110 in reaped[-1]:
            check(reaped[-1][110]["members"] == [110, 1100], "il TERM va a tutto l'albero")
        check(not any(k.startswith("150@") for k in state), "un client azzera il conto")
        check(any(v.startswith("aspetta") and "lsof non risponde" in v for r, v in report
                  if r["root"] == 198), "lsof muto si dice nel --list")
        check(any(v.startswith("aspetta (log in Desktop, Documenti") for r, v in report
                  if r["root"] == 148), "un log in cartella protetta si dice nel --list e non conta")
        check(all(r["weak"] for r in rows if r["root"] in (143, 144, 145, 174, 142))
              and not any(r["weak"] for r in rows if r["root"] in (110, 140)),
              "solo il «finito» di Topics da solo e' un indizio debole")
        try:
            FakeProbe({5: 6}, {}, {}, {}, {}, []).responsible(5)
            check(False, "il kernel finto rifiuta un responsabile morto")
        except AssertionError:
            check(True, "il kernel finto rifiuta un responsabile morto (il vero non lo da' mai)")

        # La memoria dei lanciatori: chi era figlio di una sessione o di un demone vivo si
        # ricorda, chi era figlio di un'app ospite no (un'app che riparte non abbandona nessuno).
        check(memory.launcher_of(100, procs) == f"700@{procs[700]['start']}",
              "memoria: il figlio di una sessione viva e' ricordato col suo lanciatore")
        check(memory.launcher_of(162, procs) is None and memory.launcher_of(170, procs) is None,
              "memoria: i figli dell'app ospite (Topics Host) non si ricordano")
        check(memory.launcher_of(190, procs) is None, "memoria: chi e' nato staccato non ha lanciatore")
        check(f"110@{procs[110]['start']}" in memory.dump(), "memoria: si salva anche per i resti")
        stale = mod.RespMemory({f"110@{int(NOW - 40 * H)}": "999@1"})   # stesso pid, altra partenza
        check(stale.launcher_of(110, procs) is None, "memoria: la voce di un altro processo con lo stesso pid non vale")
        stale.observe(procs, probe, owners, UID)
        check(f"110@{int(NOW - 40 * H)}" not in stale.dump(), "memoria: la voce di un pid riciclato si dimentica")

        # Lo stesso cammino come accade davvero: prima il figlio ha il responsabile vivo,
        # poi il responsabile muore e il kernel lo dichiara responsabile di se' stesso.
        lifecycle(mod, check)
        sessione_ripresa(mod, check)
        lanciatore_riciclato(mod, check)
        sessione_ripresa_dal_file(mod, check)
        if real:
            kernel_vero(mod, check)       # prima che LiveProbe diventi il finto

        # La riga del --list rispetta il contratto con mac-health, anche in osservazione.
        ok_contract = all(CONTRACT.match(mod.resto_line(r, v, procs, 123.4, kill=kill))
                          for r, v in report for kill in (0, 1))
        check(ok_contract, "ogni riga --list rispetta il contratto «resto pid= albero= fp=MB eta=m»")
        row = {"root": 110, "members": [110, 1100], "why": "responsabile 999 morto"}
        seen = mod.resto_line(row, "si chiude ora", procs, 77, kill=0)
        check(seen.endswith("-> osservo: si chiuderebbe ora") and " fp=77MB " in seen,
              f"in sola osservazione il --list dice «osservo»: {seen.strip()}")
        check(mod.resto_line(row, "si chiude ora", procs, 77, kill=1).endswith("-> si chiude ora")
              and mod.resto_line(row, "in uso, il conto riparte", procs, 77, kill=0)
              .endswith("-> in uso, il conto riparte"),
              "con la classe accesa «si chiude ora»; «in uso» resta «in uso»")

        # Il giro vero in sola osservazione: nessun segnale, stato scritto, una riga per resto.
        signals, logged = [], []
        mod.LiveProbe, mod.footprint_mb = (lambda: probe), (lambda pid: 10.0)
        mod.STATE_RESTO = Path(t) / "devreap-resto.json"
        mod.kill_tree = lambda pids, dry=False, grace=6: signals.append((sorted(pids), dry)) or "TERM"
        mod.log = lambda msg, echo=False: logged.append(msg)
        mod.STATE_RESTO.write_text(json.dumps({"kids": memory.kids}))
        for _ in range(2):
            mod.reap_resto(procs, False, owners)
        saved = json.loads(mod.STATE_RESTO.read_text())
        watched = sorted(int(m.split("pid=")[1].split()[0]) for m in logged if m.startswith("OSSERVO-RESTO"))
        check(mod.RESTO_KILL == 0 and not signals and watched == [140]
              and saved.get("counts") and saved.get("kids"),
              f"sola osservazione: 0 segnali, stato scritto, OSSERVO-RESTO una volta: {watched}")
        mod.RESTO_KILL = 1
        mod.reap_resto(procs, False, owners)
        check(any(not dry for _, dry in signals), "con DEVREAP_RESTO_KILL=1 il TERM parte")
        mod.RESTO_KILL = 0

        # Il Topics DB c'e' ma non si legge: ne' comandi ne' scratchpad si danno per chiusi.
        bad_db = Path(t) / "rotto.db"
        bad_db.write_bytes(b"questo non e' un database sqlite" * 8)
        blind = mod.Owners(procs, sessions=Path(t) / "sessions",
                           scripts=Path(t) / "scripts.json", db=bad_db)
        verdicts = {pid: mod.owner_gone(pid, [pid], procs, probe, blind, memory)
                    for pid in (170, 180)}
        check(verdicts == {170: None, 180: None},
              f"DB di Topics illeggibile: mai (comando aperto?, sessione aperta?) {verdicts}")

        # I socket unix dal lsof vero del ponte: la connessione accettata e' un client.
        check(mod.unix_clients(BRIDGE_LSOF) == 1, "ponte di Topics: 1 client sul socket unix")
        only_listen = "p1\nf3\nd0xaa\nn/tmp/x.sock\nf4\nd0xbb\nn->0xcc\n"
        inner = "p1\nf3\nd0xaa\nn/tmp/x.sock\nf4\nd0xbb\nn/tmp/x.sock\np2\nf3\nd0xdd\nn->0xbb\n"
        check(mod.unix_clients(only_listen) == 0 and mod.unix_clients(inner) == 0
              and mod.unix_clients("") == 0,
              "socket solo in ascolto, client verso fuori o collegato dentro l'albero: 0")

        # REAP-SCRATCH: la scratchpad di una sessione viva non e' piu' sua da prendere,
        # neanche se e' di un terminale Topics parcheggiato.
        cmd = "python3 -m http.server 4100 --bind 127.0.0.1"
        sp = {501: proc(1, cmd, 2 * H), 502: proc(1, cmd, 2 * H), 503: proc(1, cmd, 2 * H)}
        where = {501: f"/private/tmp/claude-501/-Users-x/{LIVE_SID}/scratchpad/dist",
                 502: f"/private/tmp/claude-501/-Users-x/{DEAD_SID}/scratchpad/dist",
                 503: f"/private/tmp/claude-501/-Users-x/{DORM_SID}/scratchpad/dist"}
        mod.cwd_of, mod.net = where.get, lambda pid: ({"4100"}, 0)
        got = {r["pid"] for r in mod.scratch_servers(sp, owners)}
        check(got == {502}, f"REAP-SCRATCH salta le sessioni vive e parcheggiate, prende la chiusa: {sorted(got)}")

        check(not touched, f"nessuno stat su Desktop, Documenti o Download: {touched}")

    # Le tre cartelle TCC e il confine: «Documents-vecchi» non e' «Documents».
    h = str(Path.home())
    check(all(mod.tcc_protected(f"{h}/{d}{sub}") for d in ("Desktop", "Documents", "Downloads")
              for sub in ("", "/x/y")), "TCC: Desktop, Documents e Downloads, la cartella e il suo contenuto")
    check(not any(mod.tcc_protected(f"{h}/{d}") for d in ("Documents-vecchi", "Desktop2", "Downloadsx", "Projects")),
          "TCC: una cartella dal nome simile non e' protetta")

    # ps con un byte non UTF-8 (0xcc, il crash del 25/10): il giro non si perde.
    raw = (b"    1     0     0   0.0 01:00 Sun Oct 25 10:00:00 2026 /sbin/launchd\n"
           b"  42     1   501   0.0 1-02:03:04 Sat Oct 24 08:56:56 2026 /bin/caf\xcc\x28 -x\n")
    table = mod.ps_table(raw)
    check(sorted(table) == [1, 42] and table[42]["age"] == 93784 and table[42]["uid"] == 501,
          "ps_table regge un argv non UTF-8")


def lanciatore_riciclato(mod, check):
    """Il pid del CLI che aveva lanciato il figlio e' tornato a un altro processo (ora di
    partenza diversa): il lanciatore e' morto, il figlio e' un resto. Vale solo con pid e
    ora di partenza insieme."""
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        sessions = tmp / "s"
        sessions.mkdir()
        before = {1: proc(0, "/sbin/launchd", 99 * H, 0), 4000: proc(1, CLAUDE_EXE, 9 * H),
                  6000: proc(1, "node server.js", 5 * H)}
        (sessions / "4000.json").write_text(json.dumps({
            "pid": 4000, "sessionId": DEAD_SID,
            "procStart": time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime(before[4000]["start"]))}))
        exe = {4000: CLAUDE_EXE, 6000: "/opt/homebrew/bin/node"}
        cwd = {6000: str(tmp)}
        p1 = FakeProbe({6000: 4000}, exe, cwd, {}, {}, [])
        p1.procs = before
        memory = mod.RespMemory()
        memory.observe(before, p1, mod.Owners(before, sessions=sessions, scripts=tmp / "no.json",
                                              db=tmp / "no.db"), UID)
        # Il CLI muore; il suo pid va a un altro processo, nato dopo.
        after = {1: before[1], 6000: before[6000], 4000: proc(1, "/bin/sleep 5", 600)}
        (sessions / "4000.json").unlink()
        p2 = FakeProbe({}, exe, cwd, {}, {}, [])
        p2.procs = after
        owners = mod.Owners(after, sessions=sessions, scripts=tmp / "no.json", db=tmp / "no.db")
        rows = mod.resto_candidates(after, p2, owners, UID, memory=memory)
        check([r["root"] for r in rows if r["root"] == 6000] == [6000],
              "lanciatore con il pid riciclato: il figlio e' un resto (pid e ora di partenza, non il solo pid)")


def sessione_ripresa(mod, check):
    """La sessione sopravvive al suo CLI: Claude.app riparte e la STESSA sessione riprende
    con un CLI nuovo. I figli del CLI vecchio (un nohup dalla cartella del progetto, fuori
    dalla scratchpad) restano suoi: il padrone e' morto solo se il CLI e' morto E la
    sessione non e' viva. Il controllo: senza CLI nuovo la sessione e' chiusa, e il resto
    si chiude davvero."""
    sid = "77777777-7777-4777-8777-777777777777"
    utc = lambda p: time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime(p["start"]))

    def scenario(resumed, http):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            proj, sessions = tmp / "Projects-sito", tmp / "s"
            proj.mkdir()
            sessions.mkdir()
            cmd = f"{PY_EXE} -m http.server 8000" if http else "node server.js --port 4801"
            # Prima: il CLI 4000 della sessione ha lanciato con nohup il server 6000.
            before = {1: proc(0, "/sbin/launchd", 99 * H, 0), 4000: proc(1, CLAUDE_EXE, 9 * H),
                      6000: proc(1, cmd, 5 * H)}
            (sessions / "4000.json").write_text(json.dumps(
                {"pid": 4000, "sessionId": sid, "procStart": utc(before[4000])}))
            exe = {4000: CLAUDE_EXE, 5000: CLAUDE_EXE, 6000: PY_EXE if http else "/opt/homebrew/bin/node"}
            cwd = {6000: str(proj)}
            log = tmp / "server.log"
            log.write_text("x")
            os.utime(log, (NOW - 3 * H, NOW - 3 * H))
            p1 = FakeProbe({6000: 4000}, exe, cwd, {}, {}, [])
            p1.procs = before
            memory = mod.RespMemory()
            memory.observe(before, p1, mod.Owners(before, sessions=sessions, scripts=tmp / "no.json",
                                                  db=tmp / "no.db"), UID)
            # Poi il CLI 4000 muore. Resumed: la stessa sessione riparte col CLI 5000.
            after = {1: before[1], 6000: before[6000]}
            (sessions / "4000.json").unlink()
            if resumed:
                after[5000] = proc(1, CLAUDE_EXE, 0.5 * H)
                (sessions / "5000.json").write_text(json.dumps(
                    {"pid": 5000, "sessionId": sid, "procStart": utc(after[5000])}))
            owners = mod.Owners(after, sessions=sessions, scripts=tmp / "no.json", db=tmp / "no.db")
            p2 = FakeProbe({}, exe, cwd, {} if http else {6000: [str(log)]},
                           {6000: ({"8000"}, 0, True)} if http else {}, [])
            p2.procs = after
            state, closed = {}, False
            for when in (NOW - 2 * H - 60, NOW - H, NOW):
                rows = mod.resto_candidates(after, p2, owners, UID, memory=memory)
                reap, state, _ = mod.resto_decide(rows, after, p2, state, when)
                closed = closed or any(r["root"] == 6000 for r in reap)
            return closed

    for http, what in ((False, "nohup node"), (True, "http.server su 0.0.0.0")):
        check(not scenario(True, http), f"sessione ripresa con un CLI nuovo: il {what} del CLI vecchio non e' un resto")
        check(scenario(False, http), f"sessione chiusa (nessun CLI nuovo): il {what} e' un resto")


def sessione_ripresa_dal_file(mod, check):
    """Come gira davvero: ogni giro di devreap e' un processo nuovo (launchd ogni 5 minuti) e
    la sessione del lanciatore passa da un giro all'altro solo nel file di stato («sids»).
    Giro 1 col CLI vivo, giro 2 con la stessa sessione ripresa da un CLI nuovo: il server
    lanciato dal CLI vecchio non e' un resto. Prende la scrittura e la rilettura di «sids»,
    che sessione_ripresa (memoria in RAM) non vede (verifica del 25/10)."""
    sid = "77777777-7777-4777-8777-777777777777"
    utc = lambda p: time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime(p["start"]))
    saved = {k: getattr(mod, k) for k in ("LiveProbe", "footprint_mb", "STATE_RESTO", "kill_tree", "log")}
    try:
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            proj, sessions, state = tmp / "Projects-sito", tmp / "s", tmp / "devreap-resto.json"
            proj.mkdir()
            sessions.mkdir()
            before = {1: proc(0, "/sbin/launchd", 99 * H, 0), 4000: proc(1, CLAUDE_EXE, 9 * H),
                      6000: proc(1, f"{PY_EXE} -m http.server 8000", 5 * H)}
            (sessions / "4000.json").write_text(json.dumps(
                {"pid": 4000, "sessionId": sid, "procStart": utc(before[4000])}))
            exe = {4000: CLAUDE_EXE, 5000: CLAUDE_EXE, 6000: PY_EXE}

            def giro(procs, probe):
                logged = []
                mod.LiveProbe, mod.footprint_mb = (lambda: probe), (lambda pid: 1.0)
                mod.STATE_RESTO = state
                mod.kill_tree = lambda *a, **k: (_ for _ in ()).throw(AssertionError("segnale in un test"))
                mod.log = lambda msg, echo=False: logged.append(msg)
                owners = mod.Owners(procs, sessions=sessions, scripts=tmp / "no.json", db=tmp / "no.db")
                mod.reap_resto(procs, False, owners)
                return logged

            p1 = FakeProbe({6000: 4000}, exe, {6000: str(proj)}, {}, {6000: ({"8000"}, 0, True)}, [])
            p1.procs = before
            giro(before, p1)
            saved_sids = json.loads(state.read_text()).get("sids") or {}
            check(sid in saved_sids.values(), "file di stato: la sessione del lanciatore si salva fra un giro e l'altro")
            after = {1: before[1], 6000: before[6000], 5000: proc(1, CLAUDE_EXE, 0.5 * H)}
            (sessions / "4000.json").unlink()
            (sessions / "5000.json").write_text(json.dumps(
                {"pid": 5000, "sessionId": sid, "procStart": utc(after[5000])}))
            p2 = FakeProbe({}, exe, {6000: str(proj)}, {}, {6000: ({"8000"}, 0, True)}, [])
            p2.procs = after
            logs = giro(after, p2)
            check(not [m for m in logs if m.startswith("OSSERVO")],
                  "giro nuovo dal file, sessione ripresa: l'http.server del CLI vecchio non e' un resto")
    finally:
        for k, v in saved.items():
            setattr(mod, k, v)


def lifecycle(mod, check):
    """Prima il figlio ha il responsabile vivo, poi il responsabile muore. Il kernel finto
    fa come il vero: dopo la morte il figlio e' responsabile di se' stesso, ppid 1."""
    def ps(alive):
        t = {1: proc(0, "/sbin/launchd", 99 * H, 0)}
        t[3000] = proc(1, CLAUDE_EXE, 9 * H)                   # sessione Claude (CLI)
        t[3001] = proc(1, HOST_EXE, 9 * H)                     # Topics Host
        t[3002] = proc(1, f"{JCODE_EXE} serve", 9 * H)         # demone
        for pid, parent in ((4001, 3000), (4002, 3001), (4003, 3002), (4004, 1), (4005, 3000)):
            t[pid] = proc(parent if alive else 1, f"bun figlio{pid}.ts", 5 * H)
        if not alive:
            for pid in (3000, 3001, 3002, 4005):                # il resto della famiglia e' morto
                del t[pid]
            t[4005] = proc(3000, "bun ancora-figlio.ts", 5 * H)  # questo ha ancora il padre
        return t

    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        sessions = tmp / "s"
        sessions.mkdir()
        before = ps(True)
        (sessions / "3000.json").write_text(json.dumps({
            "pid": 3000, "sessionId": LIVE_SID,
            "procStart": time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime(before[3000]["start"]))}))
        exe = {3000: CLAUDE_EXE, 3001: HOST_EXE, 3002: JCODE_EXE}
        cwd = {p: str(tmp) for p in (4001, 4002, 4003, 4004, 4005)}
        resp_before = {4001: 3000, 4002: 3001, 4003: 3002, 4005: 3000}   # 4004: nato staccato, di se'
        probe = FakeProbe(resp_before, exe, cwd, {}, {}, [])
        probe.procs = before
        owners = mod.Owners(before, sessions=sessions, scripts=tmp / "no.json", db=tmp / "no.db")
        memory = mod.RespMemory()
        memory.observe(before, probe, owners, UID)
        kept = sorted(int(k.split("@")[0]) for k in memory.kids)
        check(kept == [4001, 4003, 4005],
              f"osservo: ricordo i figli della sessione e del demone, non quelli dell'ospite: {kept}")
        # Ora muoiono sessione, ospite e demone. Il kernel vero: i figli diventano di se' stessi.
        after = ps(False)
        for p in (4001, 4002, 4003, 4004):
            after[p]["ppid"] = 1
        probe2 = FakeProbe({}, exe, cwd, {}, {}, [])            # nessun responsabile: tutti di se' stessi
        probe2.procs = after
        owners2 = mod.Owners(after, sessions=sessions, scripts=tmp / "no.json", db=tmp / "no.db")
        rows = mod.resto_candidates(after, probe2, owners2, UID, memory=memory)
        got = {r["root"]: r["why"] for r in rows}
        check(sorted(got) == [4001, 4003] and all("responsabile" in w and "morto" in w for w in got.values()),
              f"morta la sessione e il demone, i loro figli sono resti; l'ospite e il nato staccato no: {got}")


def kernel_vero(mod, check):
    """La premessa, sul kernel vero: processi veri, un responsabile che muore. Un padre
    lanciato con il disclaim e' responsabile di se' stesso e del figlio; quando muore il
    figlio non ha mai un responsabile morto: e' responsabile di se' stesso, ppid 1."""
    lib = ctypes.CDLL("/usr/lib/libSystem.dylib")
    if not hasattr(lib, "responsibility_spawnattrs_setdisclaim"):
        check(False, "kernel vero: manca responsibility_spawnattrs_setdisclaim")
        return
    with tempfile.TemporaryDirectory() as t:
        tmp = os.path.realpath(t)
        pidfile = os.path.join(tmp, "child.pid")
        attr = ctypes.c_void_p()
        lib.posix_spawnattr_init(ctypes.byref(attr))
        setd = lib.responsibility_spawnattrs_setdisclaim
        setd.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
        setd(ctypes.byref(attr), 1)
        argv = ["/bin/sh", "-c", f"cd '{tmp}'; /bin/sleep 300 >/dev/null 2>&1 & echo $! > child.pid; wait"]
        cargv = (ctypes.c_char_p * (len(argv) + 1))(*[a.encode() for a in argv], None)
        cenv = (ctypes.c_char_p * (len(os.environ) + 1))(
            *[f"{k}={v}".encode() for k, v in os.environ.items()], None)
        father, child = ctypes.c_int(), 0
        try:
            if lib.posix_spawn(ctypes.byref(father), b"/bin/sh", None, ctypes.byref(attr), cargv, cenv):
                check(False, "kernel vero: posix_spawn fallito")
                return
            father = father.value
            for _ in range(50):
                time.sleep(0.1)
                if os.path.exists(pidfile) and os.path.getsize(pidfile):
                    child = int(open(pidfile).read())
                    break
            probe = mod.LiveProbe()
            owners = mod.Owners(mod.ps_table(), sessions=Path(tmp) / "no", scripts=Path(tmp) / "no.json",
                                db=Path(tmp) / "no.db")
            before = mod.ps_table()
            memory = mod.RespMemory()
            memory.observe(before, probe, owners, os.getuid())
            check(child and probe.responsible(child) == father and memory.kids.get(
                f"{child}@{before[child]['start']}") == f"{father}@{before[father]['start']}",
                f"kernel vero: il figlio {child} ha per responsabile il padre {father} e lo ricordo")
            os.kill(father, signal.SIGKILL)
            os.waitpid(father, 0)
            time.sleep(0.5)
            after = mod.ps_table()
            check(after[child]["ppid"] == 1 and probe.responsible(child) == child
                  and probe.responsible(father) == -1,
                  "kernel vero: morto il responsabile il figlio e' di se' stesso, ppid 1; un pid morto da' -1, mai lui")
            mod.ONLY_PATH = tmp                          # il recinto: solo il mio figlio
            try:
                rows = mod.resto_candidates(after, probe, owners, os.getuid(), memory=memory)
            finally:
                mod.ONLY_PATH = ""
            check([r["root"] for r in rows] == [child] and f"responsabile {father} morto" in rows[0]["why"],
                  f"kernel vero: fine di un responsabile -> il figlio e' un resto: {[(r['root'], r['why']) for r in rows]}")
        finally:
            for p in (child, father if isinstance(father, int) else 0):
                if p:
                    try:
                        os.kill(p, signal.SIGKILL)
                    except OSError:
                        pass


def main():
    print("== resto: la suite sul codice vero")
    fails = run(load(), real=True)
    print("\n== mutazioni: ognuna toglie una protezione, la suite deve fallire")
    text, missed = SRC.read_text(), 0
    for name, old, new in MUTATIONS:
        if text.count(old) != 1:
            print(f"  FAIL {name}: la riga da mutare non c'e' piu', il mutante non proverebbe niente")
            missed += 1
            continue
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                caught = run(load(text.replace(old, new)))
            except Exception as e:           # un mutante che rompe il codice e' preso
                caught = f"crash {type(e).__name__}"
        print(f"  {'ok  ' if caught else 'FAIL'} {name}: {caught} rossi")
        missed += not caught
    print(f"\n{'verde' if not fails else f'{fails} falliti'}; "
          f"mutanti presi {len(MUTATIONS) - missed}/{len(MUTATIONS)}")
    return 0 if not fails and not missed else 1


if __name__ == "__main__":
    sys.exit(main())
