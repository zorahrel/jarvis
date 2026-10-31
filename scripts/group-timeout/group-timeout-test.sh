#!/usr/bin/env bash
# Banco di group-timeout: un git con un filtro clean lento (come git-crypt su un file con lo stat sporco)
# fermato dal tetto non deve lasciare il filtro vivo. Leggero: un repo da un file, niente git-crypt vero.
#   group-timeout-test.sh            GT_SCRIPT=<copia> per provare un mutante
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd)
GT=${GT_SCRIPT:-$D/group-timeout}
T=$(mktemp -d "${TMPDIR:-/tmp}/gt-test.XXXXXX")
fails=0; oks=0
check() { if eval "$2"; then echo "  ok   $1"; oks=$((oks+1)); else echo "  FAIL $1"; fails=$((fails+1)); fi; }
alive() { [ -s "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
cleanup() { for f in "$T"/*.pid; do [ -s "$f" ] && pkill -P "$(cat "$f")" 2>/dev/null; [ -s "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
exec </dev/null   # lanciato da un terminale, group-timeout farebbe come l'alarm di prima (vedi la sezione 5)

echo "== 1. l'uscita del comando passa com'è"
"$GT" 5 sh -c 'exit 3'; rc=$?
check "exit 3 resta 3" '[ $rc = 3 ]'

echo "== 2. tetto scattato su git a metà del filtro clean"
R=$T/repo; git init -q "$R"; git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo '* filter=slow' > "$R/.gitattributes"; echo dato > "$R/f.txt"
git -C "$R" config filter.slow.clean cat; git -C "$R" add -A; git -C "$R" commit -qm uno
# il filtro lento scrive il suo pid e poi resta lì, come un git-crypt clean appeso
printf '#!/bin/bash\necho $$ > %s/filter.pid\nsleep 300\ncat\n' "$T" > "$T/slow-filter"; chmod +x "$T/slow-filter"
git -C "$R" config filter.slow.clean "$T/slow-filter"
touch -t 202001010000 "$R/f.txt"    # stat sporco: git deve ripassare il file dal filtro
t0=$SECONDS; "$GT" 1 git -C "$R" status --porcelain >/dev/null 2>&1; rc=$?
check "exit 142 come l'alarm di prima" '[ $rc = 142 ]'
check "fermato entro 3 s" '[ $((SECONDS - t0)) -le 3 ]'
check "il filtro è partito davvero" '[ -s "$T/filter.pid" ]'
sleep 0.3
check "il filtro non resta appeso" '! alive "$T/filter.pid"'

echo "== 2b. tetto scattato con un NIPOTE: il passo non e' un exec, il figlio diretto (bash) ha un figlio suo"
# come git con git-crypt dietro: fermare solo il pid di bash lascia il nipote vivo con ppid 1
t0=$SECONDS; "$GT" 1 bash -c "sleep 300 & echo \$! > $T/grand.pid; wait"; rc=$?
check "nipote: exit 142" '[ $rc = 142 ]'
check "nipote: fermato entro 3 s" '[ $((SECONDS - t0)) -le 3 ]'
check "nipote: e' partito davvero" '[ -s "$T/grand.pid" ]'
sleep 0.3
check "nipote: non resta vivo" '! alive "$T/grand.pid"'

echo "== 3. a comando finito, gli avanzi nel suo gruppo si chiudono (come faceva launchd a fine job)"
"$GT" 5 bash -c "sleep 300 & echo \$! > $T/leftover.pid"; rc=$?
sleep 0.3
check "exit 0" '[ $rc = 0 ]'
check "l'avanzo in background è chiuso" '! alive "$T/leftover.pid"'

echo "== 4. se fermano group-timeout (stop del job di launchd, Ctrl-C, terminale chiuso), il passo non resta orfano"
for sig in TERM INT HUP; do
  "$GT" 8 bash -c "echo \$\$ > $T/sig-$sig.pid; exec sleep 300" & gt=$!
  for _ in $(seq 50); do [ -s "$T/sig-$sig.pid" ] && break; sleep 0.1; done
  sleep 0.2; kill -"$sig" "$gt"; wait "$gt"; rc=$?
  sleep 0.2
  check "$sig: il passo e' chiuso" '[ -s "$T/sig-$sig.pid" ] && ! alive "$T/sig-$sig.pid"'
  check "$sig: esce 128+n" '[ $rc = $((128 + $(kill -l "$sig"))) ]'
done

echo "== 4b. fermato group-timeout con un nipote vivo: chiude anche lui"
for sig in TERM INT HUP; do
  "$GT" 8 bash -c "sleep 300 & echo \$! > $T/gsig-$sig.pid; wait" & gt=$!
  for _ in $(seq 50); do [ -s "$T/gsig-$sig.pid" ] && break; sleep 0.1; done
  sleep 0.2; kill -"$sig" "$gt"; wait "$gt"; rc=$?
  sleep 0.2
  check "$sig: il nipote e' chiuso" '[ -s "$T/gsig-$sig.pid" ] && ! alive "$T/gsig-$sig.pid"'
done

echo "== 5. a mano in primo piano su un terminale: il passo legge dal terminale (in un gruppo di sfondo prenderebbe SIGTTIN)"
# un pty vero: group-timeout ne e' il capo sessione, in primo piano, come lanciato da una shell
out=$(python3 -I - "$GT" <<'PY'
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], "4", "/bin/bash", "-c", "read x; echo letto=$x"])
os.write(fd, b"ciao\n")
buf, end = b"", time.time() + 6
while time.time() < end and b"letto=" not in buf:
    if select.select([fd], [], [], 0.2)[0]:
        try: buf += os.read(fd, 1024)
        except OSError: break
_, st = os.waitpid(pid, 0)
print("letto=ciao" if b"letto=ciao" in buf else "niente", os.waitstatus_to_exitcode(st))
PY
)
check "legge la riga ed esce 0 ($out)" '[ "$out" = "letto=ciao 0" ]'

echo; echo "$oks ok, $fails FAIL"
[ $fails = 0 ]
