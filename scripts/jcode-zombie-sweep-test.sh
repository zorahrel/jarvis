#!/bin/bash
# Barra del server jcode a richiesta: jcode-zombie-sweep (spegnimento a vuoto), jcode-auth-sync (niente reload a
# vuoto) e jcode-snapshot (muto a server spento), contro un finto jcode. Il "server" è un processo che annota il segnale ricevuto: spento vuol dire che il
# SIGTERM l'ha preso davvero. I client sono connessioni vere a un socket in ascolto, come quelle che conta lsof.
# Nessun file vero toccato: HOME, socket e stato stanno in una cartella temporanea.
#
#   jcode-zombie-sweep-test.sh            i casi, poi le mutazioni (devono far diventare rosso il caso giusto)
#   SRC=<dir> jcode-zombie-sweep-test.sh  prova la copia in <dir> (serve alle mutazioni)
set -u
SRC="${SRC:-$(cd "$(dirname "$0")" && pwd)}"
T=$(mktemp -d "${TMPDIR:-/tmp}/jcode-ondemand-test.XXXXXX")
# i processi finti nascono staccati (padre launchd, che li raccoglie subito): uno zombie del test risponderebbe a kill -0
trap 'xargs kill 2>/dev/null <"$T/pids"; rm -rf "$T"' EXIT
fails=0
ok() { echo "ok   $*"; }
ko() { echo "FAIL $*"; fails=$((fails + 1)); }

touch "$T/pids"; mkdir -p "$T/bin" "$T/home/.local/bin" "$T/home/.jcode" "$T/fake" "$T/path"
cp "$SRC/jcode-zombie-sweep" "$SRC/jcode-auth-sync.py" "$SRC/jcode-snapshot" "$T/bin/"
export HOME="$T/home" FAKE_DIR="$T/fake" JCODE_SOCKET="$T/jcode.sock" JCODE_IDLE_STATE="$T/idle-since"
unset JCODE_BIN JCODE_IDLE_MINUTES

# finto jcode: lo stato del "server" sta in file di FAKE_DIR; `down` = debug che non risponde
cat >"$T/home/.local/bin/jcode" <<'SH'
#!/bin/bash
D="$FAKE_DIR"; v() { cat "$D/$1" 2>/dev/null || echo 0; }
echo "$*" >>"$D/invocations"
if [ "$1" = debug ] && [ -f "$D/down" ]; then echo "Debug socket not available" >&2; exit 1; fi
case "$1 ${2:-}" in
  "debug server:info") printf '{"pid":%s,"session_count":%s,"live_swarm_member_count":%s}\n' "$(v pid)" "$(v sessions)" "$(v swarm)" ;;
  "debug clients") printf '{"count":%s}\n' "$(v clients)" ;;
  "debug sessions") jq -nc --argjson n "$(v sessions)" '[range($n)]' ;;
  "debug background:tasks")   # tasks in corso, tasks_done finiti: .count li conta tutti, come jcode
    jq -nc --argjson r "$(v tasks)" --argjson d "$(v tasks_done)" \
      '([range($r) | {status: "running"}] + [range($d) | {status: "completed"}]) | {count: length, tasks: .}' ;;
  "debug jobs") jq -nc --argjson n "$(v jobs)" '[range($n)]' ;;
  *) echo "$*" >>"$D/calls" ;;
esac
SH
# finto Keychain: il token nuovo di vdm
cat >"$T/path/security" <<'SH'
#!/bin/bash
echo '{"claudeAiOauth":{"accessToken":"tok-new","refreshToken":"ref-new","expiresAt":1999999999999,"scopes":["user:inference"]}}'
SH
chmod +x "$T/home/.local/bin/jcode" "$T/path/security"

# un server finto acceso, fermo, senza stato vecchio: annota in fake/signal il segnale che lo spegne (KILL non lascia
# traccia, ed è il punto)
# Chi ascoltava e i client del caso prima se ne vanno: un ascolto vecchio sullo stesso percorso lsof lo vedrebbe ancora.
reset() {
  if [ -f "$T/fake/procs" ]; then
    xargs kill 2>/dev/null <"$T/fake/procs"
    for p in $(cat "$T/fake/procs"); do while kill -0 "$p" 2>/dev/null; do sleep 0.05; done; done
  fi
  rm -rf "$T/fake" "$JCODE_SOCKET" "$JCODE_IDLE_STATE"; mkdir -p "$T/fake"
  (/usr/bin/python3 -c 'import signal, sys, time
def bye(n, f):
    open(sys.argv[1], "w").write(signal.Signals(n).name); sys.exit(0)
signal.signal(signal.SIGTERM, bye); time.sleep(300)' "$T/fake/signal" >/dev/null 2>&1 & echo $! >"$T/fake/pid")
  cat "$T/fake/pid" >>"$T/pids"
  sleep 0.2   # il gestore del segnale deve essere armato prima che lo sweep spari
}
pid() { cat "$T/fake/pid"; }
alive() { kill -0 "$(pid)" 2>/dev/null; }
sweep() { "$T/bin/jcode-zombie-sweep" "$@" 2>&1; }
idle_for() { echo "$(pid) $(( $(date +%s) - $1 ))" >"$JCODE_IDLE_STATE"; }
# socket con qualcuno in ascolto o stantio (file rimasto, nessuno sopra). Chi ascolta fa come il server: accetta, tiene
# aperte le connessioni dei client e chiude quelle che finiscono (le sonde di socket_alive)
listen() { (/usr/bin/python3 -c 'import select, socket, sys, time
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(16); conns = []; end = time.time() + 120
while time.time() < end:
    for x in select.select([s] + conns, [], [], 1)[0]:
        if x is s: conns.append(s.accept()[0])
        elif not x.recv(1): x.close(); conns.remove(x)' "$JCODE_SOCKET" >/dev/null 2>&1 & echo $! | tee -a "$T/pids" >>"$T/fake/procs"); sleep 0.5; }
client() { (/usr/bin/python3 -c 'import socket, sys, time
c = socket.socket(socket.AF_UNIX); c.connect(sys.argv[1]); time.sleep(120)' "$JCODE_SOCKET" >/dev/null 2>&1 & echo $! | tee -a "$T/pids" >>"$T/fake/procs"); sleep 0.5; }
stale() { /usr/bin/python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$JCODE_SOCKET"; }
auth_sync() {
  echo '{"anthropic_accounts":[{"label":"vdm","access":"tok-old","refresh":"ref-old","expires":1,"scopes":[]}]}' >"$HOME/.jcode/auth.json"
  PATH="$T/path:$PATH" /usr/bin/python3 "$T/bin/jcode-auth-sync.py" 2>&1
}
synced() { jq -e '.anthropic_accounts[0].access == "tok-new"' "$HOME/.jcode/auth.json" >/dev/null && [ ! -e "$HOME/.jcode/vdm-auth-reload-pending" ]; }
reloaded() { grep -q '^server reload' "$T/fake/calls" 2>/dev/null; }

# --- spegnimento a vuoto (--idle-stop, 10 minuti di fila) ---
reset; listen; out=$(sweep --idle-stop)
alive && [ "$(cut -d' ' -f1 "$JCODE_IDLE_STATE" 2>/dev/null)" = "$(pid)" ] && ok "fermo, primo giro: parte il conto, server vivo" || ko "fermo, primo giro: $out"
reset; listen; idle_for 590; out=$(sweep --idle-stop)
alive && [ -f "$JCODE_IDLE_STATE" ] && ok "fermo da 9 min 50 s: resta acceso" || ko "fermo da 9 min 50 s: $out"
reset; listen; idle_for 601; out=$(sweep --idle-stop); sleep 0.3
! alive && [ ! -f "$JCODE_IDLE_STATE" ] && grep -q "spento con SIGTERM" <<<"$out" && ok "fermo da 10 min: SIGTERM, una riga di log" || ko "fermo da 10 min: $out"
[ "$(cat "$T/fake/signal" 2>/dev/null)" = SIGTERM ] && ok "fermo da 10 min: il segnale è TERM, mai KILL" || ko "fermo da 10 min: segnale «$(cat "$T/fake/signal" 2>/dev/null)»"
reset; listen; client; echo 1 >"$T/fake/clients"; idle_for 3600; out=$(sweep --idle-stop)
alive && [ ! -f "$JCODE_IDLE_STATE" ] && ok "un client: resta acceso e il conto si azzera" || ko "un client: $out"
[ ! -f "$T/fake/invocations" ] && ok "un client: lo conta lsof, jcode non si lancia" || ko "un client: $(wc -l <"$T/fake/invocations" | tr -d ' ') chiamate a jcode"
reset; listen; client; sleep 0.2; kill "$(tail -1 "$T/fake/procs")"; sleep 0.5; idle_for 601; out=$(sweep --idle-stop); sleep 0.3
! alive && ok "client andato via: la connessione chiusa non conta, si spegne" || ko "client andato via: $out"
reset; listen; echo 1 >"$T/fake/sessions"; idle_for 3600; out=$(sweep --idle-stop)
alive && [ ! -f "$JCODE_IDLE_STATE" ] && ok "una sessione: resta acceso e il conto si azzera" || ko "una sessione: $out"
reset; listen; echo 1 >"$T/fake/tasks"; idle_for 3600; out=$(sweep --idle-stop)
alive && ok "un task in corso: resta acceso" || ko "un task in corso: $out"
reset; listen; echo 2 >"$T/fake/tasks_done"; idle_for 601; out=$(sweep --idle-stop); sleep 0.3
! alive && ok "due task finiti (file di stato rimasti): si spegne" || ko "due task finiti: $out"
reset; listen; echo 1 >"$T/fake/jobs"; idle_for 3600; out=$(sweep --idle-stop)
alive && ok "un lavoro in background (debug jobs): resta acceso" || ko "un lavoro in background: $out"
reset; listen; mkdir -p "$HOME/.jcode/ambient"; echo '[{"id":"sched_1"}]' >"$HOME/.jcode/ambient/queue.json"; idle_for 3600; out=$(sweep --idle-stop)
alive && ok "un promemoria programmato: resta acceso" || ko "un promemoria programmato: $out"
rm -f "$HOME/.jcode/ambient/queue.json"
reset; listen; echo "999999 $(( $(date +%s) - 3600 ))" >"$JCODE_IDLE_STATE"; out=$(sweep --idle-stop)
alive && [ "$(cut -d' ' -f1 "$JCODE_IDLE_STATE")" = "$(pid)" ] && ok "pid nuovo: il conto riparte da zero" || ko "pid nuovo: $out"
reset; stale; idle_for 3600; out=$(sweep --idle-stop); rc=$?
[ "$rc" = 0 ] && [ ! -f "$JCODE_IDLE_STATE" ] && [ ! -f "$T/fake/invocations" ] && ok "server spento (socket stantio): niente da fare, jcode non si lancia" || ko "server spento: rc=$rc $out"

# --- --stop-if-idle, la porta di jcode-auth-sync ---
reset; touch "$T/fake/down"; listen; out=$(sweep --stop-if-idle); rc=$?
[ "$rc" = 1 ] && ok "debug muto ma socket vivo: non verificabile (exit 1)" || ko "debug muto ma socket vivo: rc=$rc $out"
reset; touch "$T/fake/down"; stale; out=$(sweep --stop-if-idle); rc=$?
[ "$rc" = 3 ] && ok "socket stantio: nessun server (exit 3)" || ko "socket stantio: rc=$rc $out"

# --- jcode-auth-sync nei tre casi, con il token appena ruotato ---
reset; touch "$T/fake/down"; stale; out=$(auth_sync); rc=$?
[ "$rc" = 0 ] && synced && ! reloaded && alive && ok "auth-sync, server spento: credenziali scritte, nessun reload" || ko "auth-sync, server spento: rc=$rc $out"
reset; out=$(auth_sync); rc=$?; sleep 0.3
[ "$rc" = 0 ] && synced && ! reloaded && ! alive && ok "auth-sync, server fermo: SIGTERM al posto del reload" || ko "auth-sync, server fermo: rc=$rc $out"
reset; echo 1 >"$T/fake/clients"; out=$(auth_sync); rc=$?
[ "$rc" = 0 ] && synced && reloaded && alive && ok "auth-sync, un client: reload di sempre" || ko "auth-sync, un client: rc=$rc $out"
reset; touch "$T/fake/down"; listen; out=$(auth_sync); rc=$?
[ "$rc" = 0 ] && synced && reloaded && ok "auth-sync, debug muto ma socket vivo: reload (non lascia il token vecchio)" || ko "auth-sync, debug muto: rc=$rc $out"

# --- jcode-snapshot (launchd ogni 5 minuti): a server spento non lancia jcode ---
reset; stale; "$T/bin/jcode-snapshot" >/dev/null 2>&1
[ ! -f "$T/fake/invocations" ] && ok "snapshot, server spento: jcode non si lancia (niente ERROR nel suo log)" || ko "snapshot, server spento: $(cat "$T/fake/invocations")"
reset; listen; echo 1 >"$T/fake/sessions"; "$T/bin/jcode-snapshot" >/dev/null 2>&1
grep -q '^restart save' "$T/fake/calls" 2>/dev/null && ok "snapshot, server acceso con una sessione: salva" || ko "snapshot, server acceso: $(cat "$T/fake/invocations" 2>/dev/null)"

# --- mutazioni: ogni punto critico tolto deve far fallire la barra ---
if [ -z "${MUTANT:-}" ]; then
  mutant() {   # $1 nome, $2 file, $3 espressione sed che toglie il controllo
    local m="$T/mut-$1"; mkdir -p "$m"; cp "$SRC/jcode-zombie-sweep" "$SRC/jcode-auth-sync.py" "$SRC/jcode-snapshot" "$m/"
    sed -i '' "$3" "$m/$2"
    if cmp -s "$SRC/$2" "$m/$2"; then ko "mutazione $1: il punto non c'è più nel sorgente"; return; fi
    if MUTANT=1 SRC="$m" bash "$0" >/dev/null 2>&1; then ko "mutazione $1: la barra resta verde"; else ok "mutazione $1: la barra diventa rossa"; fi
  }
  mutant senza-controllo-client jcode-zombie-sweep '/debug clients/s/jq -r .\.count \/\/ "x"./jq -r 0/'
  mutant senza-probe-socket jcode-zombie-sweep 's/^  if socket_alive; then$/  if false; then/'
  mutant conta-anche-i-task-finiti jcode-zombie-sweep 's/jq -r "\$running"/jq -r .count/'
  mutant senza-controllo-lavori jcode-zombie-sweep '/debug jobs/s/jq -r .length./jq -r 0/'
  mutant stato-non-azzerato-se-occupato jcode-zombie-sweep 's/then rm -f "\$STATE"; exit 0; fi/then exit 0; fi/'
  mutant kill-al-posto-di-term jcode-zombie-sweep 's/kill -TERM "\$pid"/kill -KILL "\$pid"/'
  mutant client-non-contati-da-lsof jcode-zombie-sweep 's/\[ "\${n:-0}" -le 1 \]/true/'
  mutant snapshot-a-server-spento jcode-snapshot '/lsof -t "\$SOCK"/d'
fi

[ "$fails" = 0 ] && { echo "VERDE"; exit 0; }
echo "ROSSO: $fails"; exit 1
