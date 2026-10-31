#!/usr/bin/env bash
# Suite di openclaw-safe-update. `openclaw`, `npm`, `launchctl`, `agents-doctor`, `trash`, `lsof` e
# la patch MCP sono finti, in testa al PATH, e HOME e' una cartella temporanea: la suite non tocca
# mai l'OpenClaw vero (ne' ~/.openclaw ne' lo stato in ~/.claude/jarvis/state).
#
# Il finto tiene lo stato in un JSON (versione installata, plugin, patch, pid del gateway, fase
# dell'update, guasti da iniettare) e scrive ogni chiamata in calls.log: i test guardano cosa e'
# stato chiamato. Come OpenClaw vero, l'update allinea i plugin non fissati e tiene i pin esatti.
#
#   openclaw-safe-update-test.sh             la suite
#   OSU_SCRIPT=<copia> ...test.sh            la stessa suite su una copia mutata dello script
#   OSU_ONLY=2b ...test.sh                   solo la sezione 2b (o 2c): la usa openclaw-safe-update-mutants.sh
#   OSU_ONLY=33 OSU_DX_MUTANT=K3|K4 ...test.sh   solo il caso 33, con un mutante della posa di produzione
set -uo pipefail

SCRIPT="${OSU_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/openclaw-safe-update}"
# per il caso 32 (patch consegne scadute vera): presi qui, prima che setup restringa il PATH
DX_FIX="$(cd "$(dirname "$0")/.." && pwd)/openclaw-descendant-expiry-fix/openclaw-descendant-expiry-fix.py"
DX_NODE_DIR="$(dirname "$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$(command -v node)")")"
DX_REAL_DIST="$(dirname "$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$(command -v openclaw)")")/dist"
T=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/osu-test.XXXXXX")" && pwd -P)  # niente // nel percorso: Python lo normalizza
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (atteso '$3', avuto '$2')"; fi; }
has()  { grep -q -- "$2" "$3" && ok "$1" || bad "$1 (manca '$2' in ${3##*/})"; }
hasnt(){ grep -q -- "$2" "$3" && bad "$1 (c'e' '$2' in ${3##*/})" || ok "$1"; }

mkdir -p "$T/bin"
cat > "$T/bin/fake.py" <<'PY'
#!/usr/bin/env python3
import json, os, signal, sys, time
S = os.environ["FAKE_STATE"]
st = json.load(open(S))
name, args = os.path.basename(sys.argv[0]), sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as f:
    pol = os.environ.get("OPENCLAW_SERVICE_REPAIR_POLICY")
    f.write(" ".join([name] + args) + (f" [policy={pol}]" if pol else "") + "\n")
def save(): json.dump(st, open(S, "w"))
def out(o): print(json.dumps(o))
def healthy(): return st["version"] != st.get("bad_version")
def down(): return st["version"] == st.get("down_version")
PINNED = {"whatsapp", "tokenjuice"}  # installSpec con la versione esatta, come sul Mac
a = " ".join(args)

if name == "launchctl":
    if args[0] == "print" and "ai.openclaw.gateway" in a:
        print(f"state = running\n\tpid = {st['pid']}")
    elif args[0] == "print":
        sys.exit(113)
    elif args[0] == "kickstart":
        st["pid"] += 1
        st["patch_live"] = st["patched"]
        st["ann_live"] = st["ann_patched"]
        save()
    sys.exit(0)

if name == "mcp-lazy":
    if args[0] == "check":
        ok = st["patched"] and st["patch_live"]
        print("ok   patch attiva" if ok else "FAIL patch openclaw-mcp-lazy assente")
        sys.exit(0 if ok else 1)
    if args[0] == "upstream":
        sys.exit(1)
    if args[0] == "apply":
        st["patched"] = True; save(); print("patch applicata"); sys.exit(0)

if name == "announce-fix":
    if args[0] == "check":
        ok = st["ann_patched"] and st["ann_live"]
        print("ok   patch attiva" if ok else "FAIL patch openclaw-announce-fix assente")
        sys.exit(0 if ok else 1)
    if args[0] == "apply":
        if st.get("ann_fail"):
            print("ERRORE: forma cambiata", file=sys.stderr); sys.exit(1)
        st["ann_patched"] = True; save(); print("patch applicata"); sys.exit(0)

if name == "agents-doctor":
    print("ok   qualcosa")
    fails = list(st.get("doctor_fails", []))
    if not (st["patched"] and st["patch_live"]):
        fails.append("OpenClaw: tool MCP a richiesta (openclaw-mcp-lazy.py check)")
    if not (st["ann_patched"] and st["ann_live"]):
        fails.append("OpenClaw: fine sottoagenti in privato (openclaw-announce-fix.py check)")
    try:  # come la riga vera: la versione del bundle dell'app del Mac contro quella della CLI
        import plistlib
        av = plistlib.load(open(os.environ["OSU_APP"] + "/Contents/Info.plist", "rb"))["CFBundleShortVersionString"]
    except (OSError, KeyError, ValueError):
        av = None
    if av and av != st["version"]:
        fails.append(f"OpenClaw: app del Mac {av} diversa dalla CLI {st['version']}")
    for x in fails: print("FAIL " + x)
    sys.exit(1 if fails else 0)

if name == "trash":
    sys.exit(0)

if name == "pgrep":
    # l'unico pgrep dello script cerca una finestra di profilo heap in volo (diagnostics.heapProfile):
    # senza il finto, la suite dipenderebbe dai profili che girano davvero sul Mac
    if st.get("heap_window"): print(4242); sys.exit(0)
    sys.exit(1)

if name == "lsof":
    # come lsof 4.91 del Mac: exit 1 con o senza file trovati; un +D che non esiste fa rifiutare
    # tutto il lotto (usage su stderr, stdout vuoto, sempre exit 1). lsof_rc forza l'uscita (124 = timeout)
    dirs = [args[i + 1] for i, x in enumerate(args) if x == "+D"]
    if "lsof_rc" in st: sys.exit(st["lsof_rc"])
    if not all(os.path.isdir(d) for d in dirs):
        print("lsof 4.91\n usage: [-?abhKlnNoOPRtUvVX] [+|-c c] [+|-d s] [+D D]", file=sys.stderr); sys.exit(1)
    for d in dirs:
        if os.path.basename(d) in st.get("open_dirs", []): print(f"p4242\nn{d}/package-0/index.js")
    sys.exit(1)

if name == "npm":
    if args[0] == "view" and "versions" in args:
        out(["2026.9.5", "2026.9.6", "2026.9.7"]); sys.exit(0)
    if args[0] == "view":
        out(">=" + args[1].rsplit("@", 1)[1]); sys.exit(0)
    sys.exit(1)

# ---- openclaw
def phase(ph, secs, late):
    """Una fase dell'update che dura `secs`. SIGINT prima dell'attivazione = interruzione pulita;
    dopo (late) = installazione a meta', che lo script non deve mai provocare."""
    global st
    st["active_run"] = {"phase": ph, "status": "running", "runId": "run-" + ph}; save()
    def onint(*_):
        s = json.load(open(S))
        if s.get("sigint_stale"):  # SIGINT prima che OpenClaw installi il gestore: la riga resta running
            sys.exit(130)
        s.pop("active_run", None)
        s["last_run"] = {"status": "failed", "reason": "interrupted"}
        if late: s["interrupted_late"] = True
        json.dump(s, open(S, "w")); out({"run": s["last_run"]}); sys.exit(130)
    signal.signal(signal.SIGINT, onint)
    time.sleep(secs)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    st = json.load(open(S)); st.pop("active_run", None); save()

if args == ["--version"]:
    print(f"OpenClaw {st['version']} (fake)"); sys.exit(0)
if args[:2] == ["update", "cleanup"]:
    # il vero rifiuta a gateway acceso (possesso dello stato, provato il 26/10): qui lo stesso
    if "--dry-run" in args:
        out({"status": "preview", "totals": {"candidateBytes": st.get("cand_bytes", 0)}}); sys.exit(0)
    if not st.get("gw_stopped"):
        out({"status": "blocked", "error": "state database is busy", "totals": {"removedBytes": 0}}); sys.exit(1)
    st["cand_bytes"] = 0; save(); out({"status": "removed", "totals": {"removedBytes": 439000000}}); sys.exit(0)
if args[:2] in (["gateway", "stop"], ["gateway", "start"]):
    st["gw_stopped"] = args[1] == "stop"; save(); sys.exit(0)
if args[:2] == ["update", "status"]:
    r = {"update": {"root": os.environ["FAKE_ROOT"]},
         "availability": {"latestVersion": st["latest"]}, "lastRun": st.get("last_run", {})}
    if st.get("active_run"): r["activeRun"] = st["active_run"]
    out(r); sys.exit(0)
if args[:2] == ["update", "repair"]:
    ar = st.get("active_run")
    if ar and ar.get("phase") in ("requested", "staging", "validating", "repairing") and not st.get("repair_finalize"):
        # come OpenClaw 2026.9.5: gateway sano + driver morto = riga chiusa, niente Doctor ne' riavvio
        st.pop("active_run"); st["last_run"] = {"status": "failed", "reason": "abandoned"}; save()
        out({"status": "ok", "mode": "repair", "restart": False, "reconciledRuns": [ar.get("runId")],
             "message": "Gateway is healthy. Reconciled 1 abandoned update run. No maintenance or service restart was needed."})
        sys.exit(0)
    # finalizzazione completa: il Doctor ferma il gateway, a meno che il servizio sia esterno
    if os.environ.get("OPENCLAW_SERVICE_REPAIR_POLICY") == "external":
        print("Gateway state is owned by a running Gateway; stop it through its supervisor", file=sys.stderr); sys.exit(1)
    st["pid"] += 1; st.pop("active_run", None); save()
    out({"status": "ok", "mode": "repair", "restart": True}); sys.exit(0)
if args[0] == "update":
    tag = args[args.index("--tag") + 1]
    # come la 2026.10.8: un downgrade senza la variabile del recupero voluto si rifiuta
    ver = lambda v: tuple(int(x) for x in v.split("."))
    if ver(tag) < ver(st["version"]) and os.environ.get("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS") != "1" \
            or st.get("rollback_fail") and ver(tag) < ver(st["version"]):
        run = {"status": "failed", "reason": "runtime-verification-failed: Set OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1"}
        st["last_run"] = run; save(); out({"run": run}); sys.exit(1)
    fail = st.get("update_fail")
    if fail and tag == st["latest"]:
        run = {"status": fail, "reason": "managed-service-preflight",
               "steps": [{"step": "managed-service-preflight", "status": "failed",
                          "failureFacts": [{"message": "This command is running inside the gateway process tree (gateway PID 42)."}]}]}
        st["last_run"] = run; save(); out({"run": run}); sys.exit(1)
    if st.get("busy_during_validation"): st["tasks_running"] = 1; save()
    if st.get("stage"):  # come OpenClaw: lo stage accanto al pacchetto, lasciato se l'update e' interrotto
        stage = os.path.join(os.path.dirname(os.environ["FAKE_ROOT"]), f".openclaw.update-stage-{os.getpid()}")
        os.makedirs(os.path.join(stage, "lib"), exist_ok=True); st["stage_dir"] = stage; save()
    if st.get("spawn_worker"):  # figlio detached, come update-candidate-state.worker.js
        import subprocess
        w = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "update-candidate-state.worker.js"],
                             start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        st["worker_pid"] = w.pid; save()
    phase("validating", st.get("validate_s", 0), False)
    st["version"] = tag; st["patched"] = st["patch_live"] = st["ann_patched"] = st["ann_live"] = False; st["pid"] += 1
    for p in st["plugins"]:
        if p not in PINNED: st["plugins"][p] = tag
    if st.get("busy_after_update"): st["tasks_running"] = 1
    save()
    phase("verifying", st.get("verify_s", 0), True)
    st["last_run"] = {"status": "succeeded"}; save(); out({"run": {"status": "succeeded"}}); sys.exit(0)
if args[:2] == ["tasks", "list"]:
    n = st.get("tasks_running", 0) if "running" in args else 0
    out({"count": n, "tasks": [{}] * n}); sys.exit(0)
if args[:1] == ["health"]:
    if down(): print("gateway closed", file=sys.stderr); sys.exit(1)
    # tasks_running = una persona sta scrivendo adesso: e' l'unico segnale di «occupato» (26/10), e lo
    # script lo legge dal SQLite dell'agente, non da health. A 0 la riga del finto sparisce.
    import sqlite3
    d = os.path.expanduser("~/.openclaw/agents/main/agent"); os.makedirs(d, exist_ok=True)
    con = sqlite3.connect(d + "/openclaw-agent.sqlite")
    con.executescript("""create table if not exists session_nodes (session_key text primary key, current_session_id text not null);
      create table if not exists transcript_events (session_id text not null, seq integer not null, event_json text,
      created_at integer not null, event_zstd blob, navigation_json text, primary key (session_id, seq));""")
    con.execute("delete from transcript_events where session_id = 'sid-fake'")
    if st.get("tasks_running", 0) > 0:
        con.execute("insert into transcript_events values ('sid-fake', 1, ?, ?, null, null)",
                    (json.dumps({"type": "message", "message": {"role": "user", "idempotencyKey": "channel-user:v1:x"}}),
                     int(time.time() * 1000)))
    con.commit(); con.close()
    out({"ok": True, "plugins": {"loaded": ["whatsapp"], "errors": []},
         "channels": {"whatsapp": {"accounts": {"default": {"activeRuns": st.get("active_runs", 0),
                                                            "busy": st.get("tasks_running", 0) > 0}}}},
         "sessions": {"recent": st.get("recent", [])}}); sys.exit(0)
if args[:2] == ["channels", "status"]:
    if down(): sys.exit(1)
    out({"channels": {"whatsapp": {"configured": True, "running": True, "connected": True, "linked": True,
                                    "healthState": "healthy" if healthy() else "unstable"}}}); sys.exit(0)
if args[:2] == ["gateway", "status"]:
    out({"rpc": {"ok": not down(), "server": {"version": st["version"]}}}); sys.exit(0)
if args[:2] == ["plugins", "list"]:
    if st.get("plugins_list_fail"): print("gateway closed", file=sys.stderr); sys.exit(1)
    for d in st.get("plugins_list_rm", []):  # qualcun altro toglie una build mentre lo script lavora
        import shutil; shutil.rmtree(os.path.join(os.environ["HOME"], ".openclaw/tmp", d), ignore_errors=True)
    out({"plugins": [{"id": p, "version": v, "origin": "global",
                      "trust": {"installSpec": f"@openclaw/{p}" + (f"@{v}" if p in PINNED else "")},
                      **({"source": st["plugin_source"]} if p == "whatsapp" and st.get("plugin_source") else {})}
                     for p, v in st["plugins"].items()]}); sys.exit(0)
if args[:2] == ["plugins", "install"]:
    if st.get("plugin_fail"): print("Plugin replacement failed", file=sys.stderr); sys.exit(1)
    pkg, v = args[2].rsplit("@", 1)
    st["plugins"][pkg.split("/")[-1]] = v; save(); sys.exit(0)
if args[:2] == ["config", "get"]:
    print("false"); sys.exit(0)
if args[:2] == ["config", "set"]:
    sys.exit(0)
if args[:3] == ["backup", "sqlite", "create"]:
    sys.exit(0)
HB_SKIP = {"status": "skipped", "error": "heartbeat skipped: alerts-disabled"}
if args[:2] == ["cron", "list"]:
    job = {"id": "hb-1", "name": "heartbeat-main"}
    if st.get("hb_skip"): job["state"] = {"lastRunStatus": HB_SKIP["status"], "lastError": HB_SKIP["error"]}
    out({"jobs": [job]}); sys.exit(0)
if args[:2] == ["cron", "run"] and st.get("hb_stuck"):
    out({"ok": True, "ran": False, "reason": "already-running"}); sys.exit(0)
if args[:2] == ["cron", "run"]:
    rid = "manual:hb-1:%d:1" % int(time.time() * 1000)  # come la 10.8: il runId e' nell'esito
    if st.get("hb_skip"):
        st["hb"] = dict(HB_SKIP, ts=time.time() * 1000, runId=rid)
    else:
        err = ""
        if st.get("hb_wa_bug"): err = "heartbeat failed: No active WhatsApp Web listener (account: default)"
        elif st["version"] == st.get("hb_fail_version"): err = "model call failed: HTTP 500"
        st["hb"] = {"ts": time.time() * 1000, "status": "ok" if healthy() and not err else "error",
                    "error": err, "runId": rid}
    st["hb_polls"] = 0; save(); out({"ok": True, "enqueued": True, "runId": rid}); sys.exit(0)
if args[:2] == ["cron", "runs"]:
    # come il vero: solo i run finiti, e --run-id mostra solo quello. hb_slow = il run finisce dopo
    # tot letture (28/10: il manuale delle 04:40 era ancora in corso dopo gli 8 min del --wait).
    st["hb_polls"] = st.get("hb_polls", 0) + 1; save()
    hb = st.get("hb")
    if "--run-id" in args and (not hb or hb.get("runId") != args[args.index("--run-id") + 1]): hb = None
    if hb and st["hb_polls"] <= st.get("hb_slow", 0): hb = None
    out({"entries": [hb] if hb else []}); sys.exit(0)
if args[:2] == ["cron", "get"]:
    out({"delivery": {"channel": "whatsapp", "to": "+15550100000"}}); sys.exit(0)
if args[:2] == ["message", "send"]:
    with open(os.environ["FAKE_MSGS"], "a") as f: f.write(args[args.index("-m") + 1] + "\n")
    sys.exit(0)
print("fake openclaw: comando non previsto: " + a, file=sys.stderr); sys.exit(2)
PY
chmod +x "$T/bin/fake.py"
# il nome del finto e' quello vero: fake.py smista su argv[0]
for n in openclaw npm launchctl agents-doctor trash lsof pgrep mcp-lazy announce-fix; do ln -s "$T/bin/fake.py" "$T/bin/$n"; done

# setup <json di stato> : HOME nuova, root finta di OpenClaw, log vuoti
setup() {
  export HOME="$T/home-$RANDOM" FAKE_STATE="$T/state.json" FAKE_CALLS="$T/calls.log" FAKE_MSGS="$T/msgs.log"
  export FAKE_ROOT="$T/root" PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" OSU_MCP_LAZY="$T/bin/mcp-lazy"
  export OSU_ANNOUNCE_FIX="$T/bin/announce-fix" OSU_DURABLE_VIEW=/usr/bin/true OSU_CLI_OUTPUT_LIMIT=/usr/bin/true OSU_BOT_MENTION=/usr/bin/true OSU_OC_RESTART=/usr/bin/true OSU_ANNOUNCE_SILENT=/usr/bin/true OSU_WA_CATCHUP=/usr/bin/true OSU_HB_SUBAGENTS=/usr/bin/true OSU_SESSION_SETTINGS=/usr/bin/true OSU_PINNED_FALLBACK=/usr/bin/true OSU_DESCENDANT_EXPIRY=/usr/bin/true OSU_CRON_RECEIPT_DDL=/usr/bin/true OSU_CRON_HISTORY_NAMES=/usr/bin/true  # patch finali, tetti, tag tra bot, sessione non pronta, ripiego: no-op nel banco
  export OSU_POLL_S=0.1 OSU_SETTLE_S=1 OSU_KICK_S=1 OSU_POST_IDLE_MIN=0.01 OSU_ROLLBACK_IDLE_MIN=0.01 OSU_MIN_FREE_GB=0 OSU_MAC_WAIT_MIN=0
  # l'app del Mac: un bundle che non c'e' e comandi che non fanno niente, cosi' nessun giro tocca l'app vera
  export OSU_APP="$T/nessuna/OpenClaw.app" OSU_OSASCRIPT=/usr/bin/false OSU_OPEN=/usr/bin/false OSU_MAC_LIBERO=/usr/bin/false OSU_APP_WAIT_S=1 OSU_APP_IDLE_MIN=0.01
  unset OPENCLAW_GATEWAY_SERVICE_PID OPENCLAW_CONFIG_PATH OSU_MAC_STATE
  mkdir -p "$HOME/.claude/jarvis/state" "$HOME/.openclaw" "$FAKE_ROOT/dist" "$HOME/.cache/claude-usage-hub"
  mac_state false  # il banco non dipende dal carico vero del Mac
  echo '{"update":{"auto":{"enabled":false}}}' > "$HOME/.openclaw/openclaw.json"
  echo 'x' > "$FAKE_ROOT/dist/mcp-http.schema-AAA.mjs"
  : > "$FAKE_CALLS"; : > "$FAKE_MSGS"
  python3 -c "
import json,sys
st={'version':'2026.9.5','latest':'2026.9.7','pid':1000,'patched':True,'patch_live':True,'ann_patched':True,'ann_live':True,
    'plugins':{'whatsapp':'2026.9.5','tokenjuice':'2026.9.5','codex':'2026.9.5'}}
st.update(json.loads(sys.argv[1] or '{}')); json.dump(st,open('$FAKE_STATE','w'))" "${1:-}"
}
arm() { echo '{"armed": true}' > "$HOME/.claude/jarvis/state/openclaw-safe-update.json"; }
mac_state() { echo "{\"at\": $(date +%s)000, \"strained\": $1, \"loadPerCore\": 3.4}" > "$HOME/.cache/claude-usage-hub/mac-state.json"; }
# sget chiave[.sotto] : legge lo stato del finto · sset chiave valore-json : lo cambia
sget() { python3 -c "import json;v=json.load(open('$FAKE_STATE'))
for k in '$1'.split('.'): v=v.get(k) if isinstance(v,dict) else None
print(v)"; }
sset() { python3 -c "import json;s=json.load(open('$FAKE_STATE'));s['$1']=json.loads('$2');json.dump(s,open('$FAKE_STATE','w'))"; }
last() { python3 -c "import json;print((json.load(open('$HOME/.claude/jarvis/state/openclaw-safe-update.json')).get('last') or {}).get('$1'))"; }
go() { "$SCRIPT" --idle-wait 0 "$@" > "$T/out.log" 2>&1; echo $?; }
fresh() { : > "$T/calls.log"; : > "$T/msgs.log"; }

# mkchat <chiave> <eta' in s>:<ruolo>:<model>[:zstd] ... : crea il SQLite dell'agente con una sessione e i
# suoi eventi, dal piu' vecchio al piu' recente. Con :zstd ruolo e model stanno solo in navigation_json,
# come negli eventi compressi di OpenClaw (event_json vuoto).
mkchat() {
  local key=$1; shift
  mkdir -p "$HOME/.openclaw/agents/main/agent"
  python3 - "$HOME/.openclaw/agents/main/agent/openclaw-agent.sqlite" "$key" "$@" <<'PY'
import json, sqlite3, sys, time
db, key, *evs = sys.argv[1:]
con = sqlite3.connect(db)
con.executescript("""create table if not exists session_nodes (session_key text primary key, current_session_id text not null);
create table if not exists transcript_events (session_id text not null, seq integer not null, event_json text,
  created_at integer not null, event_zstd blob, navigation_json text, primary key (session_id, seq));""")
sid = "sid-" + key
con.execute("insert or replace into session_nodes values (?,?)", (key, sid))
for seq, ev in enumerate(evs, 1):
    age, role, model, *mode = ev.split(":")
    role, _, who = role.partition("+")  # user = persona su un canale · user+ext · user+inter · user+sys · user+bare
    msg = {"role": role}
    if model != "-": msg["model"] = model
    if role == "user":
        key = "channel-user:v1:abc"
        if who == "bare": pass
        elif who == "inter": msg["provenance"] = {"kind": "inter_session"}
        elif who == "sys": msg["provenance"] = {"kind": "internal_system"}; msg["idempotencyKey"] = key  # visto il 26/10
        elif who == "ext": msg["provenance"] = {"kind": "external_user"}
        else: msg["idempotencyKey"] = key
    ts = int((time.time() - float(age)) * 1000)
    if mode == ["zstd"]:
        con.execute("insert into transcript_events values (?,?,?,?,?,?)",
                    (sid, seq, None, ts, b"\x00", json.dumps({"version": 1, "navigation": {"type": "message", "message": msg}})))
    else:
        con.execute("insert into transcript_events values (?,?,?,?,?,?)",
                    (sid, seq, json.dumps({"type": "message", "message": msg}), ts, None, None))
con.commit()
PY
}
# chat <eventi di mkchat...> : una sessione con quegli eventi, poi il giro
chat() { setup; arm; mkchat "$CHAT" "$@"; go >/dev/null; }
CHAT=agent:main:whatsapp:direct:+390000000000

if [ -z "${OSU_ONLY:-}" ] || [ "${OSU_ONLY:-}" = 2b ]; then
echo "== 2b. chi e' una persona: messaggio utente da un canale, le copie di consegna e il resto no (24/10: una notifica fece interrompere l'update)"
chat 3600:assistant:claude-opus-5-5 5:assistant:delivery-mirror
has "ultimo evento = copia di consegna di 5 s fa: l'update parte" "update --yes" "$T/calls.log"
chat 3600:assistant:claude-opus-5-5 9:assistant:delivery-mirror 5:assistant:delivery-mirror 2:assistant:delivery-mirror
has "solo copie in coda: parte" "update --yes" "$T/calls.log"
chat 5:user:-
hasnt "messaggio di una persona di 5 s fa: occupato" "update --yes" "$T/calls.log"
has "dice perche'" "una persona ha scritto" "$T/out.log"
chat 5:user+ext:-
hasnt "persona dalla chat di Topics (provenance external_user): occupato" "update --yes" "$T/calls.log"
chat 20:user+inter:- 5:assistant:claude-opus-5-5
has "risultato di un figlio (inter_session) e risposta di 5 s fa: parte" "update --yes" "$T/calls.log"
chat 4:user+sys:-
has "evento interno con chiave channel-user: ma provenienza internal_system (26/10): parte" "update --yes" "$T/calls.log"
chat 5:user:-:zstd
hasnt "messaggio di persona compresso (solo navigation_json): occupato" "update --yes" "$T/calls.log"
chat 20:user:- 2:assistant:delivery-mirror
hasnt "persona di 20 s fa e poi una copia: la copia non la nasconde" "update --yes" "$T/calls.log"
chat 100:user:-
hasnt "persona di 100 s fa: ancora dentro i 2 minuti" "update --yes" "$T/calls.log"
chat 130:user:-
has "persona di 130 s fa: fuori dai 2 minuti, parte" "update --yes" "$T/calls.log"
chat 4:assistant:claude-opus-5-5
has "risposta dell'agente di 4 s fa senza persona: parte (il drain la regge)" "update --yes" "$T/calls.log"
setup; arm; mkchat "$CHAT" 5:user:-; mkdir -p "$HOME/.openclaw/agents/gtm/agent"; echo "non e' sqlite" > "$HOME/.openclaw/agents/gtm/agent/openclaw-agent.sqlite"
go >/dev/null
hasnt "un DB di agente che non si legge: non si sa, occupato" "update --yes" "$T/calls.log"
fi

if [ -z "${OSU_ONLY:-}" ] || [ "${OSU_ONLY:-}" = 2c ]; then
echo "== 2c. profilo heap: non blocca piu' l'update (26/10; 25/10 era bloccato fino alle 06:15)"
setup '{"heap_window":true}'; arm
check "finestra in volo: exit 0" "$(go)" 0
has "l'update parte" "update --yes" "$T/calls.log"
fi

if [ -z "${OSU_ONLY:-}" ] || [ "${OSU_ONLY:-}" = 2d ]; then
echo "== 2d. app del Mac indietro dopo l'update (25/10: app 2026.9.5, CLI 2026.10.5): quit e open -ga a Mac fermo"
# app <versione> : un finto OpenClaw.app con un processo vivo col suo eseguibile in argv[0] (sleep), osascript
# finto che lo chiude e fa da Sparkle (alla chiusura il bundle passa a $SPARKLE_TO, se c'e'), open finto che lo riapre
app() {
  export OSU_APP="$T/app-$RANDOM/OpenClaw.app" OSU_OSASCRIPT="$T/bin/app-osascript" OSU_OPEN="$T/bin/app-open"
  mkdir -p "$OSU_APP/Contents/MacOS"; ln -s /bin/sleep "$OSU_APP/Contents/MacOS/OpenClaw"  # una copia la uccide AMFI
  python3 -c "import plistlib,sys; plistlib.dump({'CFBundleShortVersionString': sys.argv[2]}, open(sys.argv[1], 'wb'))" \
    "$OSU_APP/Contents/Info.plist" "$1"
  "$OSU_APP/Contents/MacOS/OpenClaw" 600 & echo $! > "$T/app.pid"
}
cat > "$T/bin/app-osascript" <<'SH'
#!/bin/sh
echo "osascript $*" >> "$FAKE_CALLS"
# TCC che nega gli Apple Event, come puo' capitare a un osascript lanciato da launchd
[ -n "${APP_DENY:-}" ] && { echo "0:41: execution error: Not authorized to send Apple events to OpenClaw. (-1743)" >&2; exit 1; }
[ -n "${APP_STUCK:-}" ] && exit 0
kill "$(cat "$(dirname "$FAKE_STATE")/app.pid")"
[ -n "${SPARKLE_TO:-}" ] && python3 -c "import plistlib,sys; plistlib.dump({'CFBundleShortVersionString': sys.argv[2]}, open(sys.argv[1], 'wb'))" "$OSU_APP/Contents/Info.plist" "$SPARKLE_TO"
exit 0
SH
cat > "$T/bin/app-open" <<'SH'
#!/bin/sh
echo "open $*" >> "$FAKE_CALLS"
u="$(dirname "$FAKE_STATE")/updater.pid"
[ -s "$u" ] && kill -0 "$(cat "$u")" 2>/dev/null && echo "open con l'Updater di Sparkle ancora vivo" >> "$FAKE_CALLS"
"$2/Contents/MacOS/OpenClaw" 600 > /dev/null 2>&1 & echo $! > "$(dirname "$FAKE_STATE")/app.pid"
SH
chmod +x "$T/bin/app-osascript" "$T/bin/app-open"
appkill() { kill "$(cat "$T/app.pid")" 2>/dev/null; wait 2>/dev/null; }
# sparkle <cartella> : un Autoupdate e un Updater di Sparkle per l'app finta, come quelli vivi dal 6/10 (l'Updater gira
# da <cartella>/ai.openclaw.mac/…: se la cartella non c'e', il suo binario e' sparito), e l'Updater di un'altra app
# ps finta: la vera senza gli Autoupdate e gli Updater che non sono di questo banco (quelli di ChatGPT e di OpenClaw
# veri girano sul Mac). Un mutante che allarga la regola di sparkle_leftovers non li vede, quindi non li puo' colpire
cat > "$T/bin/ps" <<SH
#!/bin/sh
/bin/ps "\$@" | /usr/bin/awk '!/Autoupdate |\/Updater / || index(\$0, "$T")'
SH
chmod +x "$T/bin/ps"
sparkle() {
  local up="$1/ai.openclaw.mac/org.sparkle-project.Sparkle/Launcher/f6ew7M4B1/Updater.app/Contents/MacOS/Updater"
  bash -c "exec -a '$OSU_APP/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate ai.openclaw.mac /Users/x x' sleep 600" &
  echo $! > "$T/autoupdate.pid"
  bash -c "exec -a '$up $OSU_APP 0 1' sleep 600" & echo $! > "$T/updater.pid"
  bash -c "exec -a '$T/cache/com.openai.codex/org.sparkle-project.Sparkle/Launcher/A/Updater.app/Contents/MacOS/Updater $T/ChatGPT.app 0' sleep 600" &
  echo $! > "$T/altro-updater.pid"
  # l'Autoupdate di un'altra app (come quello di ChatGPT): nome dedicato al banco, stessa forma di quello vero
  bash -c "exec -a '$T/ChatGPT.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate com.openai.codex /Users/x x' sleep 600" &
  echo $! > "$T/altro-autoupdate.pid"
  sleep 0.3
}
vivo() { kill -0 "$(cat "$T/$1.pid")" 2>/dev/null && echo si || echo no; }
sparklekill() { for f in autoupdate updater altro-updater altro-autoupdate; do kill "$(cat "$T/$f.pid")" 2>/dev/null; done; rm -f "$T"/*updater.pid "$T"/*autoupdate.pid; }

setup; arm; app 2026.9.5; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=2026.9.7
check "update ok con l'app indietro: exit 0" "$(go)" 0
hasnt "la riga dell'app in agents-doctor non fa tornare indietro" "tag 2026.9.5" "$T/calls.log"
check "quit per bundle id, poi open -ga" "$(grep -E '^(osascript|open) ' "$T/calls.log" | tr '\n' '|')" \
  "osascript -e tell application id \"ai.openclaw.mac\" to quit|open -ga $OSU_APP|"
has "lo scrive nel log con le due versioni" "app OpenClaw 2026.9.5 -> 2026.9.7, riaperta" "$T/out.log"
check "l'app e' di nuovo accesa" "$(kill -0 "$(cat "$T/app.pid")" 2>/dev/null && echo si)" si
appkill

setup; arm; app 2026.9.5; export OSU_MAC_LIBERO=/usr/bin/false SPARKLE_TO=2026.9.7
check "Mac in uso: exit 0" "$(go)" 0
hasnt "  e l'app non si chiude" "osascript" "$T/calls.log"
has "  e lo dice" "Mac in uso, non la riavvio" "$T/out.log"
appkill

setup; arm; app 2026.9.7; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=
go >/dev/null
hasnt "app gia' alla versione nuova: non si tocca" "osascript" "$T/calls.log"
appkill

setup; arm; app 2026.9.9; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=   # CLI 2026.9.7, l'app e' avanti (un beta, una build a mano)
check "app PIU' NUOVA della CLI: exit 0" "$(go)" 0
hasnt "  non si chiude" "osascript" "$T/calls.log"
hasnt "  e non si riapre" "open -ga" "$T/calls.log"
check "  l'app resta accesa" "$(kill -0 "$(cat "$T/app.pid")" 2>/dev/null && echo si)" si
appkill
setup; arm; app 2026.10.1; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=   # 2026.10.1 contro 2026.9.7: avanti anche se "10" < "9" come testo
go >/dev/null
hasnt "app 2026.10.1 contro CLI 2026.9.7: avanti, non si tocca" "osascript" "$T/calls.log"
appkill
setup; arm; app 2026.9.7-1; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=   # il suffisso -N non conta
go >/dev/null
hasnt "app 2026.9.7-1 contro CLI 2026.9.7: uguale, non si tocca" "osascript" "$T/calls.log"
appkill

setup; arm; app 2026.9.5; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=
go >/dev/null
has "Sparkle non installa niente: riaperta comunque, e lo dice" "Sparkle non ha installato niente" "$T/out.log"
has "  riaperta" "open -ga" "$T/calls.log"
appkill

setup; arm; app 2026.9.5; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO= APP_STUCK=1
go >/dev/null
has "l'app non si chiude: resta com'era" "non si chiude entro" "$T/out.log"
hasnt "  e non si riapre sopra" "open -ga" "$T/calls.log"
appkill; unset APP_STUCK

setup; arm; app 2026.9.5; appkill; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=2026.9.7
check "app chiusa da Attilio: exit 0" "$(go)" 0
hasnt "  niente quit" "osascript" "$T/calls.log"
hasnt "  e non si riapre" "open -ga" "$T/calls.log"
has "  lo dice" "ma chiusa" "$T/out.log"
appkill   # un mutante che la riapre non deve lasciare il processo finto acceso

setup; arm; app 2026.9.5; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO= APP_DENY=1
go >/dev/null
has "TCC nega il quit: il log dice exit e stderr di osascript" "osascript exit 1: .*Not authorized to send Apple events.*(-1743)" "$T/out.log"
hasnt "  e non si riapre sopra" "open -ga" "$T/calls.log"
appkill; unset APP_DENY

echo "== 2e. notte senza update con l'app del Mac indietro: si riallinea lo stesso, alle stesse condizioni"
setup '{"latest":"2026.9.5"}'; arm; app 2026.9.4; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=2026.9.5
check "exit 0" "$(go)" 0
hasnt "nessun update" "update --yes" "$T/calls.log"
check "quit, poi open -ga" "$(grep -E '^(osascript|open) ' "$T/calls.log" | tr '\n' '|')" \
  "osascript -e tell application id \"ai.openclaw.mac\" to quit|open -ga $OSU_APP|"
has "lo scrive con le due versioni" "app OpenClaw 2026.9.4 -> 2026.9.5, riaperta" "$T/out.log"
appkill

setup '{"latest":"2026.9.5","tasks_running":1}'; arm; app 2026.9.4; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=2026.9.5
go >/dev/null
hasnt "OpenClaw al lavoro (Mac fermo): l'app non si chiude" "osascript" "$T/calls.log"
has "  e lo dice" "OpenClaw al lavoro" "$T/out.log"
appkill

setup '{"latest":"2026.9.5"}'; arm; app 2026.9.4; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=
sparkle "$T/sparita"
go >/dev/null
check "Sparkle non installa, Updater col binario sparito: chiuso" "$(vivo updater)" no
check "  e l'Autoupdate dell'app con lui" "$(vivo autoupdate)" no
check "  l'Updater di un'altra app resta" "$(vivo altro-updater)" si
check "  l'Autoupdate di un'altra app resta" "$(vivo altro-autoupdate)" si
check "  la ps finta non mostra gli Updater veri del Mac" "$(ps -A -o command= | /usr/bin/awk '/Autoupdate |\/Updater /' | /usr/bin/grep -vc "$T")" 0
hasnt "  chiusi prima di riaprire" "open con l'Updater di Sparkle ancora vivo" "$T/calls.log"
has "  riaperta" "open -ga" "$T/calls.log"
has "  lo dice" "chiusi gli aiutanti di Sparkle rimasti" "$T/out.log"
sparklekill; appkill

setup '{"latest":"2026.9.5"}'; arm; app 2026.9.4; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=
mkdir -p "$T/viva/ai.openclaw.mac/org.sparkle-project.Sparkle/Launcher/f6ew7M4B1/Updater.app/Contents/MacOS"
touch "$T/viva/ai.openclaw.mac/org.sparkle-project.Sparkle/Launcher/f6ew7M4B1/Updater.app/Contents/MacOS/Updater"
sparkle "$T/viva"
go >/dev/null
check "Sparkle non installa ma il binario dell'Updater c'e': non si tocca" "$(vivo updater)$(vivo autoupdate)" sisi
hasnt "  e non dice di averli chiusi" "chiusi gli aiutanti" "$T/out.log"
sparklekill; appkill

setup '{"latest":"2026.9.5"}'; arm; app 2026.9.8; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=
go --dry-run >/dev/null
has "--dry-run con l'app piu' nuova: dice che non fa niente" "dry-run: app del Mac 2026.9.8 piu' nuova della CLI 2026.9.5: niente" "$T/out.log"
appkill

setup '{"latest":"2026.9.5"}'; arm; app 2026.9.4; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=2026.9.5
check "--dry-run senza update: exit 0" "$(go --dry-run)" 0
hasnt "  l'app non si tocca" "osascript" "$T/calls.log"
has "  dice cosa farebbe" "dry-run: app del Mac 2026.9.4 ≠ CLI 2026.9.5: quit e open -ga" "$T/out.log"
appkill

setup; arm; app 2026.9.5; export OSU_MAC_LIBERO=/usr/bin/true SPARKLE_TO=2026.9.7
check "--dry-run con update: exit 0" "$(go --dry-run)" 0
hasnt "  l'app non si tocca" "osascript" "$T/calls.log"
has "  il piano ha la voce dell'app" "piano: dopo il verde, app del Mac 2026.9.5 ≠ CLI 2026.9.7: quit e open -ga" "$T/out.log"
appkill; unset SPARKLE_TO
fi

if [ -z "${OSU_ONLY:-}" ] || [ "${OSU_ONLY:-}" = 33 ]; then
echo "== 33. patch consegne scadute nella posa di produzione: niente OSU_DESCENDANT_EXPIRY, percorso di default e shebang"
# Una copia della cartella scripts/ con safe-update e lo script della patch (copiati, cosi' i mutanti non
# toccano gli originali); il dist e' una copia dei tre file veri. node dalla sua cartella reale, in coda al
# PATH, perche' lo script della patch fa node --check.
DX="$T/descexp-pose-dist"  # fisso: pose gira in una sottoshell, patched() lo legge da fuori
pose() {  # pose <True|False|tolta> [K3|K4]: prepara la copia e la lancia, stampa l'exit
  local P="$T/pose-$RANDOM/scripts"; mkdir -p "$P"
  cp -R "$(dirname "$SCRIPT")" "$P/openclaw-safe-update"; cp "$SCRIPT" "$P/openclaw-safe-update/openclaw-safe-update"
  cp -R "$(dirname "$DX_FIX")" "$P/openclaw-descendant-expiry-fix"
  local S="$P/openclaw-safe-update/openclaw-safe-update"
  case "$1" in
    tolta) sed -i '' '/^DESCENDANT_EXPIRY_SUSPENDED = /d' "$S" ;;
    *) sed -i '' "s/^DESCENDANT_EXPIRY_SUSPENDED = .*/DESCENDANT_EXPIRY_SUSPENDED = $1/" "$S" ;;
  esac
  case "${2:-}" in
    K3) sed -i '' 's#"openclaw-descendant-expiry-fix/openclaw-descendant-expiry-fix.py"#"openclaw-descendant-expiry-fix/openclaw-descendant-expiry-fix.pyc"#' "$S" ;;
    K4) chmod -x "$P/openclaw-descendant-expiry-fix/openclaw-descendant-expiry-fix.py" ;;
  esac
  rm -rf "$DX"; mkdir -p "$DX"
  for a in "const activeDescendantRuns = Date.now() >= resolveAnnounceDeliveryDeadline(" \
           "async function countPendingDescendantRuns(rootSessionKey, assertCurrent" \
           "await countPendingDescendantRuns(params.childSessionKey, () => {"; do
    cp "$(grep -lF "$a" "$DX_REAL_DIST"/*.mjs)" "$DX/"
  done
  fresh
  ( unset OSU_DESCENDANT_EXPIRY; export OPENCLAW_DIST="$DX" PATH="$PATH:$DX_NODE_DIR"
    "$S" --idle-wait 0 > "$T/out.log" 2>&1; echo $? )
}
patched() { grep -l 'jarvis-patch openclaw-descendant-expiry-fix' "$DX"/*.mjs 2>/dev/null | wc -l | tr -d ' '; }
setup '{"latest":"2026.9.5"}'; arm
check "33a riaccesa (= False): exit 0" "$(pose False)" 0
check "33a i tre file patchati dal percorso di default" "$(patched)" 3
check "33a un kickstart" "$(grep -c 'launchctl kickstart' "$T/calls.log")" 1
check "33a dopo: check della patch esce 0" "$(OPENCLAW_DIST="$DX" PATH="$PATH:$DX_NODE_DIR" /usr/bin/python3 "$DX_FIX" check >/dev/null; echo $?)" 0
setup '{"latest":"2026.9.5"}'; arm
check "33b sospesa (= True): exit 0" "$(pose True)" 0
check "33b nessun file toccato" "$(patched)" 0
hasnt "33b nessun riavvio" "kickstart" "$T/calls.log"
setup '{"latest":"2026.9.5"}'; arm
check "33c riga tolta: safe-update non parte (exit 1)" "$(pose tolta)" 1
has "33c e il motivo e' il NameError" "NameError: name 'DESCENDANT_EXPIRY_SUSPENDED' is not defined" "$T/out.log"
# K3 e K4: con la patch accesa, un percorso di default rotto o uno script non eseguibile non devono passare
# in silenzio: la copia resta senza patch e safe-update lo dice ad Attilio
if [ -n "${OSU_DX_MUTANT:-}" ]; then
  setup '{"latest":"2026.9.5"}'; arm
  pose False "$OSU_DX_MUTANT" >/dev/null
  check "mutante $OSU_DX_MUTANT: i tre file patchati" "$(patched)" 3
fi
fi

if [ -z "${OSU_ONLY:-}" ] || [ "${OSU_ONLY:-}" = 26b ]; then
echo "== 26b. copie di ripristino (~500 MB a tentativo, 25/10: 13 per 6,2 GB) e originali di migrazione col comando nativo (26/10)"
# mkcaps <cartella copie> <db> <riga: id:giorni:stato:motivo:giovane?>... : storico update e una cartella di copia per riga
mkcaps() {
  python3 - "$@" <<'PY'
import os, sqlite3, sys, time
cap, db, *rows = sys.argv[1:]
os.makedirs(os.path.dirname(db), exist_ok=True)
con = sqlite3.connect(db)
con.execute("create table update_runs (run_id text primary key, created_at_ms integer, status text, reason text)")
now = time.time()
for r in rows:
    rid, days, status, reason, young = r.split(":")
    if status != "-":
        con.execute("insert into update_runs values (?,?,?,?)", (rid, int((now - float(days) * 86400) * 1000), status, reason or None))
    d = os.path.join(cap, rid); os.makedirs(d); open(d + "/payload", "w").write("x" * 1000)
    if not young: os.utime(d, (now - 7200, now - 7200))
con.commit()
PY
}
CAPROWS=(aaaa-vecchio-ok:9:succeeded:: bbbb-ultimo-ok:6:succeeded:: cccc-interrotto:4:failed:interrupted: dddd-fallito:3:failed:update-failed:
         eeee-ultimo:1:failed:runtime-verification-failed: senza-riga:0:-:: ffff-giovane:5:failed:update-failed:y)
setup '{"latest":"2026.9.5","cand_bytes":439000000}'; arm
CAP="$HOME/.openclaw.update-captures"
mkcaps "$CAP" "$HOME/.openclaw/state/openclaw.sqlite" "${CAPROWS[@]}"
check "exit 0" "$(go)" 0
caps() { ls "$CAP" | tr '\n' ' '; }
check "restano: ultimo riuscito, ultimo tentativo, senza riga nello storico, troppo giovane" "$(caps)" "bbbb-ultimo-ok eeee-ultimo ffff-giovane senza-riga "
has "lo dice" "copie di ripristino: 3 cancellate" "$T/out.log"
has "cleanup nativo con il gateway fermo" "update cleanup --yes" "$T/calls.log"
check "gateway rimesso su" "$(sget gw_stopped)" False
has "ritirati" "ritirati 439 MB" "$T/out.log"
echo "  -- una persona sta scrivendo: il gateway non si ferma"
setup '{"latest":"2026.9.5","cand_bytes":439000000,"tasks_running":1}'; arm
go >/dev/null
hasnt "niente stop del gateway" "gateway stop" "$T/calls.log"
hasnt "niente cleanup" "update cleanup --yes" "$T/calls.log"
echo "  -- sotto soglia: non vale un riavvio"
setup '{"latest":"2026.9.5","cand_bytes":4000000}'; arm
go >/dev/null
hasnt "niente stop del gateway" "gateway stop" "$T/calls.log"
echo "  -- dry-run: non cancella"
setup '{"latest":"2026.9.5","cand_bytes":439000000}'; arm
mkcaps "$HOME/.openclaw.update-captures" "$HOME/.openclaw/state/openclaw.sqlite" "${CAPROWS[@]}"
go --dry-run >/dev/null
check "dry-run: sette copie ancora li'" "$(ls "$HOME/.openclaw.update-captures" | wc -l | tr -d ' ')" 7
hasnt "dry-run: niente stop del gateway" "gateway stop" "$T/calls.log"
fi

# con OSU_ONLY=2b|2c|2d|26b|33 girano solo queste sezioni (le usa openclaw-safe-update-mutants.sh; 2e sta dentro 2d)
if [ -n "${OSU_ONLY:-}" ]; then echo; echo "$PASS ok, $FAIL FAIL"; [ "$FAIL" -eq 0 ]; exit; fi

echo "== 1. nessuna versione nuova: esce 0, non aggiorna, non scrive ad Attilio"
setup '{"latest":"2026.9.5"}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun update" "update --yes" "$T/calls.log"
hasnt "nessun riavvio" "kickstart" "$T/calls.log"
check "nessuna notifica" "$(wc -l < "$T/msgs.log" | tr -d ' ')" 0

echo "== 2. una persona sta scrivendo: nessuna azione, riprova la notte dopo (unico segnale di occupato, 26/10)"
setup '{"tasks_running":1}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun update" "update --yes" "$T/calls.log"
hasnt "nessun backup" "backup sqlite" "$T/calls.log"
has "dice perche'" "una persona ha scritto" "$T/out.log"
echo "  -- casi storici (log 16-25/10): nessuno di questi era una persona, l'update deve partire"
setup '{"active_runs":2}'; arm
go >/dev/null
has "run attivi sul canale ma nessuna persona (drain e ripresa li reggono)" "update --yes" "$T/calls.log"
setup; arm; P="$HOME/.claude/projects/$(printf %s "$HOME" | sed 's/[^A-Za-z0-9]/-/g')--openclaw"
mkdir -p "$P" && touch "$P/s.jsonl"
go >/dev/null
has "transcript claude-cli scritto adesso (heartbeat, ritentativo-chiave): no" "update --yes" "$T/calls.log"
setup '{"recent":[{"key":"agent:main:whatsapp:direct:+390000000000","age":5000}]}'; arm
go >/dev/null
has "chat 'aggiornata 5 s fa' secondo health, senza messaggi di persone" "update --yes" "$T/calls.log"
setup '{"recent":[{"key":"agent:main:subagent:abc","age":5000}]}'; arm
go >/dev/null
has "sessione di sottoagente di 5 s fa" "update --yes" "$T/calls.log"
chat 20:user+inter:- 5:assistant:claude-opus-5-5
has "risultato di un figlio (inter_session) e risposta di 5 s fa" "update --yes" "$T/calls.log"
chat 4:user+sys:-
has "evento interno con chiave channel-user: ma provenienza internal_system (26/10)" "update --yes" "$T/calls.log"
chat 3:user+inter:- 
has "sottoagente ritentato (ritentativo-chiave)" "update --yes" "$T/calls.log"
setup '{"heap_window":true}'; arm
go >/dev/null
has "finestra del profilo heap in volo (25/10, fino alle 06:15)" "update --yes" "$T/calls.log"
setup; arm
check "nessun DB di agenti (npm o primo avvio): exit 0" "$(go)" 0
has "l'update parte" "update --yes" "$T/calls.log"

echo "== 3. update ok: plugin fissati allineati, patch rimessa, un riavvio, health ok, notifica"
setup; arm
check "exit 0" "$(go)" 0
check "core" "$(sget version)" 2026.9.7
check "plugin whatsapp" "$(sget plugins.whatsapp)" 2026.9.7
check "plugin tokenjuice (fissato anche lui)" "$(sget plugins.tokenjuice)" 2026.9.7
has "whatsapp reinstallato alla versione del core, fissato" "plugins install @openclaw/whatsapp@2026.9.7 --force --pin" "$T/calls.log"
hasnt "codex non fissato: lo allinea OpenClaw" "plugins install @openclaw/codex" "$T/calls.log"
has "patch MCP riapplicata" "mcp-lazy apply" "$T/calls.log"
check "patch viva dopo il riavvio" "$(sget patch_live)" True
has "patch annunci riapplicata" "announce-fix apply" "$T/calls.log"
check "patch annunci viva dopo il riavvio" "$(sget ann_live)" True
check "un solo kickstart" "$(grep -c 'launchctl kickstart' "$T/calls.log")" 1
has "heartbeat vero" "cron run hb-1" "$T/calls.log"
has "backup prima dell'update" "backup sqlite create --global" "$T/calls.log"
has "notifica" "aggiornato 9.5→9.7, tutto verde" "$T/msgs.log"

echo "== 4. il plugin non si installa: rollback e notifica del fallimento"
setup '{"plugin_fail":true}'; arm
check "exit 1" "$(go)" 1
has "rollback chiamato" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "tornato a 9.5" "$(sget version)" 2026.9.5
has "notifica del fallimento" "fallito, tornato a 9.5" "$T/msgs.log"
has "col motivo" "plugins install" "$T/msgs.log"

echo "== 4b. rollback rifiutato da OpenClaw: exit 2, avviso ROSSO che dice cosa gira e di guardare i cron"
setup '{"plugin_fail":true,"rollback_fail":true}'; arm
check "exit 2" "$(go)" 2
check "resta la nuova" "$(sget version)" 2026.9.7
has "avviso chiaro" "ROSSO OpenClaw: update a 9.7 fallito e rollback a 9.5 NON riuscito, gira 9.7" "$T/msgs.log"
has "dice dei cron" "Controlla subito i cron" "$T/msgs.log"
check "stato" "$(last result)" rollback-failed

echo "== 5. health gate rosso sulla versione nuova: rollback; la notte dopo non la riprova"
setup '{"bad_version":"2026.9.7"}'; arm
check "exit 1" "$(go)" 1
has "rollback chiamato" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "tornato a 9.5" "$(sget version)" 2026.9.5
has "notifica col motivo" "whatsapp unstable" "$T/msgs.log"
check "patch viva dopo il rollback" "$(sget patch_live)" True
fresh
check "notte dopo: exit 0" "$(go)" 0
hasnt "notte dopo: 9.7 non si riprova" "update --yes" "$T/calls.log"
has "notte dopo: lo dice" "salto 2026.9.7" "$T/out.log"

echo "== 6. lock: un secondo giro non parte mentre il primo e' in corso"
setup; arm
python3 -c "import fcntl,time,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); time.sleep(4)" \
  "$HOME/.claude/jarvis/state/openclaw-safe-update.lock" & HOLD=$!
sleep 0.5
check "exit 3" "$(go)" 3
check "nessuna chiamata a OpenClaw" "$(wc -l < "$T/calls.log" | tr -d ' ')" 0
wait $HOLD

echo "== 7. non armato: il notturno non aggiorna finche' il giro supervisionato non e' andato"
setup
check "exit 0" "$(go)" 0
hasnt "nessun update" "update --yes" "$T/calls.log"
has "lo dice" "non armato" "$T/out.log"

echo "== 8. --dry-run: fotografa e stampa il piano, non tocca niente"
setup; arm
check "exit 0" "$(go --dry-run)" 0
for x in "update --yes" "plugins install" "kickstart" "config set" "backup sqlite" "message send" "mcp-lazy apply" "announce-fix apply"; do
  hasnt "niente $x" "$x" "$T/calls.log"; done
has "piano" "piano: openclaw update --yes --json --tag 2026.9.7" "$T/out.log"
has "piano: patch annunci" "piano: patch annunci" "$T/out.log"
has "piano: l'app del Mac" "piano: dopo il verde, app del Mac" "$T/out.log"

echo "== 9. il giro supervisionato riuscito arma il notturno"
setup
check "exit 0" "$(go --force-version 2026.9.7)" 0
check "armato" "$(python3 -c "import json;print(json.load(open('$HOME/.claude/jarvis/state/openclaw-safe-update.json')).get('armed'))")" True

echo "== 10. OpenClaw rifiuta l'update (managed-service-preflight): niente rollback nostro, motivo preciso"
setup '{"update_fail":"failed"}'; arm
check "exit 1" "$(go)" 1
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "motivo nella notifica" "managed-service-preflight: This command is running inside the gateway process tree" "$T/msgs.log"

echo "== 11. heartbeat rosso solo per il bug di consegna WhatsApp (#153453): non e' colpa dell'update"
setup '{"hb_wa_bug":true}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "lo dice" "bug noto #153453" "$T/out.log"

echo "== 12. heartbeat rosso per un errore vero, canali verdi: rollback"
setup '{"hb_fail_version":"2026.9.7"}'; arm
check "exit 1" "$(go)" 1
has "rollback chiamato" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "tornato a 9.5" "$(sget version)" 2026.9.5
has "motivo nella notifica" "heartbeat: error model call failed" "$T/msgs.log"

echo "== 13. dentro l'albero del gateway: rifiuta (exit 4) prima di toccare OpenClaw"
setup "{\"pid\":$$}"; arm
check "gateway antenato: exit 4" "$(go)" 4
hasnt "gateway antenato: nessun update" "update" "$T/calls.log"
setup; arm
check "variabile del servizio: exit 4" "$(export OPENCLAW_GATEWAY_SERVICE_PID=4242; go)" 4
hasnt "variabile del servizio: nessun update" "update" "$T/calls.log"

echo "== 14. versione nuova sana ma OpenClaw mai fermo dopo: niente riavvio, niente rollback, il giro dopo completa"
setup '{"busy_after_update":true,"verify_s":1}'; arm
check "exit 0" "$(go)" 0
check "resta 9.7" "$(sget version)" 2026.9.7
hasnt "nessun kickstart a OpenClaw occupato" "launchctl kickstart" "$T/calls.log"
hasnt "nessun plugin install a OpenClaw occupato" "plugins install" "$T/calls.log"
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
check "update mai interrotto dopo l'attivazione" "$(sget interrupted_late)" None
has "notifica: aggiornato, il resto rimandato" "aggiornato 9.5→9.7, tutto verde; plugin e patch MCP al prossimo giro" "$T/msgs.log"
fresh
check "giro dopo, ancora occupato: exit 0" "$(go)" 0
hasnt "giro dopo, ancora occupato: nessun kickstart" "launchctl kickstart" "$T/calls.log"
check "giro dopo, ancora occupato: nessuna notifica" "$(wc -l < "$T/msgs.log" | tr -d ' ')" 0
sset tasks_running 0; fresh
check "giro dopo, fermo: exit 0" "$(go)" 0
check "giro dopo: whatsapp allineato" "$(sget plugins.whatsapp)" 2026.9.7
check "giro dopo: patch viva" "$(sget patch_live)" True
check "giro dopo: un kickstart" "$(grep -c 'launchctl kickstart' "$T/calls.log")" 1
has "giro dopo: notifica" "sistemato" "$T/msgs.log"

echo "== 15. OpenClaw si mette a lavorare durante la validazione: update interrotto prima dell'attivazione"
setup '{"busy_during_validation":true,"validate_s":5}'; arm
check "exit 0" "$(go)" 0
check "resta 9.5" "$(sget version)" 2026.9.5
check "gateway mai fermato" "$(sget pid)" 1000
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "lo dice" "interrompo l'update prima dell'attivazione" "$T/out.log"
check "stato: interrotto" "$(last result)" interrupted
check "nessuna notifica" "$(wc -l < "$T/msgs.log" | tr -d ' ')" 0

echo "== 15b. --no-interrupt: OpenClaw lavora durante la validazione, l'update va avanti"
setup '{"busy_during_validation":true,"validate_s":5}'; arm
check "exit 0" "$(go --no-interrupt)" 0
check "passa a 9.7" "$(sget version)" 2026.9.7
hasnt "non interrompe" "interrompo l'update prima dell'attivazione" "$T/out.log"

echo "== 16. versione nuova rotta e OpenClaw mai fermo: rollback in sospeso senza riavvii, poi fatto a OpenClaw fermo"
setup '{"bad_version":"2026.9.7","busy_after_update":true}'; arm
check "exit 2" "$(go)" 2
check "resta 9.7 per ora" "$(sget version)" 2026.9.7
hasnt "nessun rollback a OpenClaw occupato" "tag 2026.9.5" "$T/calls.log"
hasnt "nessun kickstart a OpenClaw occupato" "launchctl kickstart" "$T/calls.log"
check "stato: in sospeso" "$(last result)" rollback-pending
has "notifica" "rollback a 9.5 rimandato" "$T/msgs.log"
sset tasks_running 0; sset busy_after_update false; fresh
check "giro dopo, fermo: exit 1 (tornato indietro)" "$(go)" 1
has "giro dopo: rollback" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "giro dopo: 9.5" "$(sget version)" 2026.9.5
check "giro dopo: stato" "$(last result)" rolled-back
has "giro dopo: notifica" "tornato a 9.5" "$T/msgs.log"

echo "== 17. gateway che non risponde dopo l'update: il rollback non aspetta (non c'e' lavoro da salvare)"
setup '{"down_version":"2026.9.7"}'; arm
check "exit 1" "$(go)" 1
has "rollback" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "tornato a 9.5" "$(sget version)" 2026.9.5
has "notifica" "tornato a 9.5" "$T/msgs.log"

# buildtmp : in ~/.openclaw/tmp una cartella di build per ogni caso, piu' un vicino che non e' di build
B=; buildtmp() {
  B="$HOME/.openclaw/tmp"; rm -rf "$T/fuori"; mkdir -p "$T/fuori/dentro" "$T/fuori/sopra"
  echo tieni > "$T/fuori/dentro/keep.txt"; echo tieni > "$T/fuori/sopra/keep.txt"
  for n in vecchia recente plugin progetto aperta; do
    mkdir -p "$B/openclaw-plugin-build-$n/package-0"; head -c 300000 /dev/zero > "$B/openclaw-plugin-build-$n/package-0/index.js"
  done
  ln -s "$T/fuori/dentro" "$B/openclaw-plugin-build-vecchia/package-0/link"   # link dentro: non va seguito
  ln -s "$T/fuori/sopra" "$B/openclaw-plugin-build-link"                       # la voce stessa e' un link
  mkdir -p "$B/agent-bin-XYZ" "$HOME/.openclaw/npm/projects/p"
  echo '{"dependencies":{"x":"file:../../../tmp/openclaw-plugin-build-progetto/package-0"}}' > "$HOME/.openclaw/npm/projects/p/package.json"
  python3 -c "import os,sys,time
t=time.time()-7*3600
for p in sys.argv[1:]: os.utime(p,(t,t),follow_symlinks=False)
t=time.time()-3600; os.utime(sys.argv[1].replace('vecchia','recente'),(t,t))" \
    "$B/openclaw-plugin-build-vecchia" "$B/openclaw-plugin-build-plugin" "$B/openclaw-plugin-build-progetto" \
    "$B/openclaw-plugin-build-aperta" "$B/openclaw-plugin-build-link" "$B/agent-bin-XYZ" \
    "$T/fuori/sopra" "$T/fuori/dentro"   # vecchi anche i bersagli: seguire il link li renderebbe candidati
}
there() { if [ -e "$B/$2" ] || [ -L "$B/$2" ]; then ok "$1"; else bad "$1 ($2 cancellata)"; fi; }
gone()  { if [ -e "$B/$2" ] || [ -L "$B/$2" ]; then bad "$1 ($2 ancora li')"; else ok "$1"; fi; }
TMPSTATE='{"latest":"2026.9.5","open_dirs":["openclaw-plugin-build-aperta"],"plugin_source":"/x/.openclaw/tmp/openclaw-plugin-build-plugin/package-0"}'

echo "== 18. pulizia tmp, anche senza update: via solo le build vecchie, non nominate e senza file aperti"
setup "$TMPSTATE"; arm; buildtmp
check "exit 0" "$(go)" 0
gone  "vecchia e inutilizzata: cancellata" openclaw-plugin-build-vecchia
there "recente (1 h): tenuta" openclaw-plugin-build-recente
there "nominata da plugins list: tenuta" openclaw-plugin-build-plugin
there "nominata da npm/projects/*/package.json: tenuta" openclaw-plugin-build-progetto
there "con un file aperto (lsof): tenuta" openclaw-plugin-build-aperta
has   "lsof sulle cartelle candidate" "lsof -w -F n +D $B/openclaw-plugin-build-aperta" "$T/calls.log"
there "voce che e' un link: tenuta" openclaw-plugin-build-link
check "link in cima non seguito" "$(cat "$T/fuori/sopra/keep.txt" 2>/dev/null)" tieni
check "link dentro non seguito" "$(cat "$T/fuori/dentro/keep.txt" 2>/dev/null)" tieni
there "il resto di tmp non si tocca" agent-bin-XYZ
has   "log: quante e quanti GB" "cancellate 1 cartelle openclaw-plugin-build-\*, 0.0 GB liberati; tenute" "$T/out.log"
hasnt "nessun update" "update --yes" "$T/calls.log"

echo "== 19. pulizia tmp con --dry-run: dice cosa cancellerebbe, non cancella niente"
setup "$TMPSTATE"; arm; buildtmp
check "exit 0" "$(go --dry-run)" 0
there "vecchia ancora li'" openclaw-plugin-build-vecchia
has   "lo dice" "cancellerei 1 cartelle" "$T/out.log"

echo "== 20. pulizia tmp prima del controllo del disco: col disco pieno l'update e' rifiutato, gli avanzi no"
setup '{"open_dirs":[]}'; arm; buildtmp
check "exit 4 (disco)" "$(OSU_MIN_FREE_GB=1000000 go)" 4
has   "rifiutato per il disco" "GB liberi sul Mac" "$T/out.log"
gone  "avanzi cancellati comunque" openclaw-plugin-build-vecchia

echo "== 21. plugins list non risponde: non si sa chi le nomina, non si cancella niente"
setup '{"latest":"2026.9.5","plugins_list_fail":true}'; arm; buildtmp
go >/dev/null
there "vecchia tenuta" openclaw-plugin-build-vecchia
has   "lo dice" "plugins list non risponde" "$T/out.log"

echo "== 22. lsof in timeout: non si sa chi le usa, non si cancella niente"
setup '{"latest":"2026.9.5","lsof_rc":124}'; arm; buildtmp
go >/dev/null
there "vecchia tenuta" openclaw-plugin-build-vecchia
has   "lo dice" "con lsof in errore" "$T/out.log"

echo "== 23. una build sparisce prima di lsof: lsof rifiuta il lotto, la build aperta resta"
setup '{"latest":"2026.9.5","open_dirs":["openclaw-plugin-build-aperta"],"plugins_list_rm":["openclaw-plugin-build-vecchia"]}'; arm; buildtmp
go >/dev/null
there "aperta tenuta" openclaw-plugin-build-aperta
has   "lo dice" "con lsof in errore" "$T/out.log"

echo "== 24. piu' di 20 build vecchie: lsof a lotti, anche il secondo lotto e' controllato"
setup '{"latest":"2026.9.5","open_dirs":["openclaw-plugin-build-n23"]}'; arm; B="$HOME/.openclaw/tmp"
for i in $(seq -w 1 25); do mkdir -p "$B/openclaw-plugin-build-n$i"; done
python3 -c "import os,sys,time
t=time.time()-7*3600
for p in sys.argv[1:]: os.utime(p,(t,t))" "$B"/openclaw-plugin-build-n*
go >/dev/null
gone  "primo lotto: cancellata" openclaw-plugin-build-n01
gone  "secondo lotto: cancellata" openclaw-plugin-build-n25
there "secondo lotto, aperta: tenuta" openclaw-plugin-build-n23
check "due chiamate a lsof" "$(grep -c '^lsof ' "$T/calls.log")" 2
has   "log" "cancellate 24 cartelle" "$T/out.log"

stages() { ls -d "$T"/.openclaw.update-stage-* 2>/dev/null | wc -l | tr -d ' '; }
alive() { kill -0 "$1" 2>/dev/null && echo vivo || echo morto; }
STALE='{"busy_during_validation":true,"validate_s":5,"sigint_stale":true,"spawn_worker":true,"stage":true}'

echo "== 25. SIGINT prima del gestore di OpenClaw (01/10 00:18): figlio orfano, run appeso, stage lasciato"
setup "$STALE"; arm; rm -rf "$T"/.openclaw.update-stage-*
mkdir -p "$T/.openclaw.update-stage-vecchio"; touch -t 202609010000 "$T/.openclaw.update-stage-vecchio"
check "exit 0" "$(go)" 0
check "resta 9.5" "$(sget version)" 2026.9.5
check "gateway mai riavviato" "$(sget pid)" 1000
W=$(sget worker_pid)
check "il worker del run interrotto non resta vivo" "$(alive "$W")" morto
has "lo dice" "figlio dell'update interrotto ancora vivo, SIGTERM: pid $W" "$T/out.log"
has "run chiuso con update repair, servizio esterno" "update repair --yes --json \[policy=external\]" "$T/calls.log"
check "nessun run attivo nello storico" "$(sget active_run)" None
has "lo dice" "chiuso con update repair" "$T/out.log"
check "stage del run cancellato, quello vecchio no" "$(stages)" 1
check "quello rimasto e' il vecchio" "$(ls -d "$T"/.openclaw.update-stage-*)" "$T/.openclaw.update-stage-vecchio"
check "stato: interrotto" "$(last result)" interrupted
check "nessuna notifica" "$(wc -l < "$T/msgs.log" | tr -d ' ')" 0
kill "$W" 2>/dev/null  # su una copia mutata resterebbe vivo

echo "== 26. update repair ripiegherebbe sul Doctor (ferma il gateway): rifiutato, nessun riavvio, stage cancellato lo stesso (26/10)"
setup "${STALE%\}},\"repair_finalize\":true}"; arm; rm -rf "$T"/.openclaw.update-stage-*
check "exit 0" "$(go)" 0
check "gateway mai fermato ne' riavviato" "$(sget pid)" 1000
check "run ancora attivo" "$(sget active_run.phase)" validating
has "lo dice" "resta attivo, update repair exit 1" "$T/out.log"
check "run ancora aperto ma figli morti: lo stage va via lo stesso" "$(stages)" 0
kill "$(sget worker_pid)" 2>/dev/null

echo "== 27. run appeso trovato all'avvio: chiuso prima dell'update; in dry-run non si tocca"
setup '{"active_run":{"phase":"validating","status":"running","runId":"run-vecchio"}}'; arm
check "dry-run: exit 0" "$(go --dry-run)" 0
hasnt "dry-run: niente update repair" "update repair" "$T/calls.log"
has "dry-run: lo dice" "ancora running in fase validating (dry-run" "$T/out.log"
fresh
check "exit 0" "$(go)" 0
check "repair prima dell'update" "$(grep -n -e 'update repair' -e 'update --yes' "$T/calls.log" | head -1 | grep -c 'update repair')" 1
check "aggiornato" "$(sget version)" 2026.9.7

echo "== 28. patch annunci che non entra nella versione nuova: l'update resta, niente rollback, lo dice"
setup '{"ann_fail":true}'; arm
check "exit 0" "$(go)" 0
check "resta 9.7" "$(sget version)" 2026.9.7
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
check "patch MCP comunque viva" "$(sget patch_live)" True
has "notifica col motivo" "patch annunci non applicata" "$T/msgs.log"

echo "== 29. nessuna versione nuova ma patch annunci assente: rimessa a OpenClaw fermo, un riavvio"
setup '{"latest":"2026.9.5","ann_patched":false,"ann_live":false}'; arm
check "exit 0" "$(go)" 0
has "patch annunci applicata" "announce-fix apply" "$T/calls.log"
check "patch annunci viva" "$(sget ann_live)" True
check "un kickstart" "$(grep -c 'launchctl kickstart' "$T/calls.log")" 1
has "notifica" "sistemato patch annunci" "$T/msgs.log"
setup '{"latest":"2026.9.5","ann_patched":false,"ann_live":false,"ann_fail":true}'; arm
check "non entra: exit 1" "$(go)" 1
has "non entra: lo dice" "non riesco a sistemare patch annunci" "$T/msgs.log"

echo "== 30. heartbeat gia' saltato prima dell'update (alerts-disabled, 08/10): non e' colpa dell'update"
setup '{"hb_skip":true}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "lo dice" "come prima dell'update" "$T/out.log"

echo "== 31. heartbeat appeso da prima (already-running, 15/10): niente rollback"
setup '{"hb_stuck":true}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "lo dice" "gia' in corso da prima del riavvio" "$T/out.log"

echo "== 32. patch consegne scadute: safe-update chiama lo script VERO (check -> apply) su una copia del dist"
# Senza update: maintain vede check=1, converge fa apply, un kickstart, e dopo check=0. La copia ha i tre
# file veri del dist installato; la sospensione in produzione (DESCENDANT_EXPIRY_SUSPENDED) qui non conta,
# perche' OSU_DESCENDANT_EXPIRY la scavalca.
setup '{"latest":"2026.9.5"}'; arm
DX="$T/descexp-dist"; rm -rf "$DX"; mkdir -p "$DX"
for a in "const activeDescendantRuns = Date.now() >= resolveAnnounceDeliveryDeadline(" \
         "async function countPendingDescendantRuns(rootSessionKey, assertCurrent" \
         "await countPendingDescendantRuns(params.childSessionKey, () => {"; do
  cp "$(grep -lF "$a" "$DX_REAL_DIST"/*.mjs)" "$DX/"
done
cat > "$T/bin/descendant-expiry" <<SH
#!/bin/sh
echo "descendant-expiry \$1" >> "$T/calls.log"
PATH="$DX_NODE_DIR:\$PATH" OPENCLAW_DIST="$DX" exec /usr/bin/python3 "$DX_FIX" "\$@"
SH
chmod +x "$T/bin/descendant-expiry"
check "prima: check della patch esce 1" "$(OPENCLAW_DIST="$DX" "$T/bin/descendant-expiry" check >/dev/null; echo $?)" 1
fresh
check "exit 0" "$(OSU_DESCENDANT_EXPIRY="$T/bin/descendant-expiry" go)" 0
has "safe-update ha fatto il check" "descendant-expiry check" "$T/calls.log"
has "e poi apply" "descendant-expiry apply" "$T/calls.log"
check "un kickstart" "$(grep -c 'launchctl kickstart' "$T/calls.log")" 1
check "i tre file della copia patchati" "$(grep -l 'jarvis-patch openclaw-descendant-expiry-fix' "$DX"/*.mjs | wc -l | tr -d ' ')" 3
check "dopo: check della patch esce 0" "$("$T/bin/descendant-expiry" check >/dev/null; echo $?)" 0
fresh
check "giro dopo: exit 0" "$(OSU_DESCENDANT_EXPIRY="$T/bin/descendant-expiry" go)" 0
hasnt "giro dopo: nessun apply" "descendant-expiry apply" "$T/calls.log"
hasnt "giro dopo: nessun riavvio" "kickstart" "$T/calls.log"

echo "== 34. Mac sotto sforzo (stato del hub): rimanda senza aggiornare, niente backup, niente messaggi"
setup; arm; mac_state true
check "exit 0" "$(go)" 0
hasnt "strained state: stub openclaw never called" "update --yes" "$T/calls.log"
hasnt "nessun backup" "backup sqlite create" "$T/calls.log"
has "lo dice" "Mac sotto sforzo, rimando" "$T/out.log"
check "nessuna notifica" "$(wc -l < "$T/msgs.log" | tr -d ' ')" 0
check "versione invariata" "$(sget version)" 2026.9.5

echo "== 35. heartbeat lento ma sano (28/10: il manuale delle 04:40 supero' gli 8 min del --wait, e cron runs elenca solo i finiti): il giro segue il suo runId, niente rollback"
setup '{"hb_slow":3}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "segue il run manuale" "cron runs hb-1 --run-id manual:hb-1:" "$T/calls.log"
setup '{"hb_slow":999999}'; arm
check "run che non finisce mai: exit 2 (l'attesa e' limitata, non si pianta)" "$(OSU_HB_BUDGET_S=0.3 go)" 2
has "run che non finisce mai: rollback" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "run che non finisce mai: tornato a 9.5" "$(sget version)" 2026.9.5
has "run che non finisce mai: lo dice" "heartbeat: run manual:hb-1:" "$T/msgs.log"

echo
echo "$PASS ok, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
