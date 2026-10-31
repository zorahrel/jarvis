#!/bin/bash
# Barra del lanciatore del server jcode (server-launch.c) e del canale che ci punta (jcode-tcc-pin.sh), su un albero
# finto: il "jcode" accanto al lanciatore è uno script che dice chi è responsabile di lui per TCC, di che sessione è,
# cosa ha nell'ambiente. Nessun file vero toccato.
#
#   server-launch-test.sh            i casi, poi le mutazioni (devono far diventare rosso il caso giusto)
#   SRC=<file.c> server-launch-test.sh  prova quella copia del sorgente (serve alle mutazioni)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${SRC:-$HERE/server-launch.c}"
PIN="$HERE/../jcode-tcc-pin.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/jcode-launch-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok   $*"; }
ko() { echo "FAIL $*"; fails=$((fails + 1)); }

/usr/bin/clang -O2 -o "$T/server-launch" "$SRC" 2>"$T/cc.err" || { cat "$T/cc.err"; echo "ROSSO: non compila"; exit 1; }
cat >"$T/jcode" <<'PY'
#!/usr/bin/python3 -I
import ctypes, json, os, sys
f = ctypes.CDLL("/usr/lib/libSystem.B.dylib").responsibility_get_pid_responsible_for_pid
f.restype, f.argtypes = ctypes.c_int, [ctypes.c_int]
print(json.dumps({"pid": os.getpid(), "resp": f(os.getpid()), "pgid": os.getpgid(0), "argv0": sys.argv[0],
                  "args": sys.argv[1:], "noninter": os.environ.get("JCODE_NON_INTERACTIVE")}), flush=True)
if os.environ.get("REEXEC") and "reexec" not in sys.argv:   # come il server che si ricarica: exec sul canale
    os.execv(os.environ["REEXEC"], [os.environ["REEXEC"], *sys.argv[1:], "reexec"])
if os.environ.get("SIGNAL_READY"): os.write(int(os.environ["JCODE_READY_FD"]), b"1")
sys.exit(int(os.environ.get("CODE", "0")))
PY
chmod +x "$T/jcode"
L="$T/server-launch"
field() { jq -r ".$1" <<<"$2"; }

# --- il lanciatore ---
out=$(JCODE_NON_INTERACTIVE=1 CODE=7 "$L" --provider auto serve); rc=$?
[ "$(field resp "$out")" = "$(field pid "$out")" ] && ok "il server nasce responsabile di sé (TCC)" || ko "responsabile: $out"
[ "$(field pgid "$out")" = "$(field pid "$out")" ] && ok "il server guida il suo gruppo (jcode server stop segnala -pid)" || ko "gruppo: $out"
[ "$(field noninter "$out")" = null ] && ok "serve: JCODE_NON_INTERACTIVE di jcode acp non arriva al server" || ko "NON_INTERACTIVE: $out"
[ "$(field argv0 "$out")" = "$(cd "$T" && pwd -P)/jcode" ] && ok "in ps il server è la copia firmata, non il lanciatore" || ko "argv0: $out"
[ "$rc" = 7 ] && ok "il lanciatore esce col codice del server" || ko "codice d'uscita: $rc"
out=$(JCODE_NON_INTERACTIVE=1 "$L" version)
[ "$(field noninter "$out")" = 1 ] && ok "fuori da serve l'ambiente resta com'è" || ko "non-serve: $out"
out=$(REEXEC="$L" "$L" serve --socket x)
[ "$(sed -n 1p <<<"$out" | jq -r .pid)" = "$(sed -n 2p <<<"$out" | jq -r .pid)" ] && [ "$(sed -n 2p <<<"$out" | jq -r '.resp == .pid')" = true ] \
  && ok "ricarica (exec sul canale da responsabile di sé): stesso pid, sempre responsabile di sé" || ko "ricarica: $out"
# come spawn_server_notify: un byte su JCODE_READY_FD = pronto; il server che muore prima deve dare EOF subito
ready() {
  /usr/bin/python3 -I - "$L" <<'PY'
import os, select, subprocess, sys, time
r, w = os.pipe(); os.set_inheritable(w, True); t = time.time()
p = subprocess.Popen([sys.argv[1], "--provider", "auto", "serve"], env=dict(os.environ, JCODE_READY_FD=str(w)),
                     pass_fds=(w,), preexec_fn=os.setsid, stdout=subprocess.DEVNULL)
os.close(w)
data = os.read(r, 1) if select.select([r], [], [], 10)[0] else b"timeout"
print(repr(data), "%.1f" % (time.time() - t)); p.wait()
PY
}
out=$(SIGNAL_READY=1 ready)
[[ "$out" == "b'1' "* ]] && ok "il segnale di pronto passa dal lanciatore" || ko "pronto: $out"
out=$(CODE=3 ready)
[[ "$out" == "b'' 0."* ]] && ok "server morto prima di essere pronto: il client lo sa subito, non dopo 10 s" || ko "morto prima: $out"

# --- il canale: jcode-tcc-pin.sh sync lo punta al lanciatore, con l'mtime della copia firmata ---
H="$T/home"; mkdir -p "$H/builds/versions/9.9.9" "$H/builds/shared-server" "$H/signed" "$H/rt"
echo 9.9.9 >"$H/builds/shared-server-version"
cp /usr/bin/true "$H/builds/versions/9.9.9/jcode"
cp /usr/bin/true "$H/signed/jcode"; touch -t 202601010000 "$H/signed/jcode"
echo "9.9.9 $(stat -f '%z %m' "$H/builds/versions/9.9.9/jcode")" >"$H/signed/jcode.source"   # copia già fresca: niente firma
touch "$H/signed/armed"
ln -s "$H/signed/jcode" "$H/builds/shared-server/jcode"
cp "$L" "$H/signed/server-launch"
JCODE_TCC_PIN_HOME="$H" JCODE_TCC_PIN_RUNTIME="$H/rt" bash "$PIN" sync
[ "$(readlink "$H/builds/shared-server/jcode")" = "$H/signed/server-launch" ] && ok "tcc-pin: il canale punta al lanciatore" || ko "canale -> $(readlink "$H/builds/shared-server/jcode")"
[ "$(stat -f %m "$H/signed/server-launch")" = "$(stat -f %m "$H/signed/jcode")" ] && ok "tcc-pin: il lanciatore ha l'mtime della copia (jcode non vede un finto aggiornamento)" || ko "mtime diversi"

# --- mutazioni ---
if [ -z "${MUTANT:-}" ]; then
  mutant() {   # $1 nome, $2 file (sorgente C o tcc-pin), $3 espressione sed
    local m="$T/mut-$1"; mkdir -p "$m"; cp "$SRC" "$m/server-launch.c"; cp "$PIN" "$m/jcode-tcc-pin.sh"
    sed -i '' "$3" "$m/$2"
    if cmp -s "$m/$2" "$([ "$2" = jcode-tcc-pin.sh ] && echo "$PIN" || echo "$SRC")"; then ko "mutazione $1: il punto non c'è più"; return; fi
    mkdir -p "$m/server-launch"; cp "$m/server-launch.c" "$m/server-launch/"; cp "$0" "$m/server-launch/"
    if MUTANT=1 bash "$m/server-launch/${0##*/}" >/dev/null 2>&1; then ko "mutazione $1: la barra resta verde"; else ok "mutazione $1: la barra diventa rossa"; fi
  }
  mutant senza-disclaim server-launch.c 's/responsibility_spawnattrs_setdisclaim(&attr, 1);//'
  mutant senza-setsid server-launch.c 's/posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSID);//'
  mutant non-interactive-resta server-launch.c 's/unsetenv("JCODE_NON_INTERACTIVE");/;/'
  mutant canale-alla-copia jcode-tcc-pin.sh 's/target="\$LAUNCH"/target="$SLOT"/'
  mutant mtime-non-allineato jcode-tcc-pin.sh 's/touch -r "\$SLOT" "\$LAUNCH"/true/'
fi

[ "$fails" = 0 ] && { echo "VERDE"; exit 0; }
echo "ROSSO: $fails"; exit 1
