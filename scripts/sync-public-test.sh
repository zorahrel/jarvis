#!/bin/bash
# Barra di sync-public.sh: HOME finto con due repo (.claude e .openclaw) e un repo jarvis finto, mai la
# config viva. Controlla che un file committato ma cancellato dal disco non fermi la copia degli altri
# (rsync su macOS si ferma al primo mancante) e che i backup restino fuori dallo specchio.
# Uso: sync-public-test.sh [script]   (con un mutante come argomento: deve andare rosso)
set -u
S="${1:-$(dirname "$0")/../sync-public.sh}"
S="$(cd "$(dirname "$S")" && pwd)/$(basename "$S")"
T=$(mktemp -d "${TMPDIR:-/tmp}/syncpub-test.XXXXXX")
fail=0
ok() { if [ "$1" = 0 ]; then echo "  ✓ $2"; else echo "  ✗ $2${3:+ — $3}"; fail=1; fi; }
trap 'trash "$T" 2>/dev/null' EXIT

export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com
H="$T/home"; export HOME="$H"
mkdir -p "$H/.claude/hooks" "$H/.claude/setup/launchagents" "$H/.openclaw/workflows" "$T/jv"

for f in a b c d e; do echo "$f" > "$H/.claude/hooks/$f.sh"; done
# Backup di ogni forma: nessuno deve arrivare nello specchio.
mkdir -p "$H/.claude/hooks/dir.bak"
for f in hooks/x.bak hooks/x.bak-2026-10-18 hooks/x.bak.2026 hooks/x.bak_old hooks/x.bak2 hooks/x.backup hooks/dir.bak/f; do echo segreto > "$H/.claude/$f"; done
# Non e' un backup: manca il punto prima di "backup".
echo plist > "$H/.claude/setup/launchagents/com.jarvis.private-backup.plist"
echo w > "$H/.openclaw/workflows/w.py"
# Backup anche in OpenClaw: file e cartella, nessuno deve arrivare nello specchio.
mkdir -p "$H/.openclaw/workflows/old.bak"
for f in workflows/w.py.bak workflows/w.py.bak-2026-10-18 workflows/old.bak/f; do echo segreto > "$H/.openclaw/$f"; done
# Test che in pubblico non girano e portano dati: restano fuori.
echo t > "$H/.claude/hooks/wait-cap-guard-test.sh"
mkdir -p "$H/.openclaw/tests"
for f in cron-health cron-route cron-when scadenze-sync stall-capture; do echo t > "$H/.openclaw/tests/$f.test.mjs"; done
for r in .claude .openclaw; do git -C "$H/$r" init -q -b main; git -C "$H/$r" add -A; git -C "$H/$r" commit -q -m base; done
cp "$S" "$T/jv/sync-public.sh"; git -C "$T/jv" init -q -b main; git -C "$T/jv" add -A; git -C "$T/jv" commit -q -m base

run() { bash "$T/jv/sync-public.sh" > "$T/out" 2>&1; }

echo "1. b.sh cancellato dal disco ma committato, c.sh modificato: il resto si copia lo stesso"
rm "$H/.claude/hooks/b.sh"; echo modificato >> "$H/.claude/hooks/c.sh"
run; rc=$?
ok $rc "esce 0" "$(cat "$T/out")"
ok $([ "$(cat "$T/jv/claude/hooks/a.sh" 2>/dev/null)" = a ] && echo 0 || echo 1) "a.sh copiato"
ok $([ "$(cat "$T/jv/claude/hooks/b.sh" 2>/dev/null)" = b ] && echo 0 || echo 1) "b.sh (sparito dal disco) arriva da HEAD"
ok $([ "$(cat "$T/jv/claude/hooks/c.sh" 2>/dev/null)" = c ] && echo 0 || echo 1) "c.sh arriva da HEAD, senza la modifica non committata"
ok $([ "$(cat "$T/jv/claude/hooks/d.sh" 2>/dev/null)" = d ] && echo 0 || echo 1) "d.sh, dopo il mancante nell'elenco, si copia"

echo "2. i backup restano fuori, il plist no"
n=$(cd "$T/jv/claude" && find . -type f | /usr/bin/grep -c -E '\.(bak|backup)')
ok $([ "$n" = 0 ] && echo 0 || echo 1) "nessun backup nello specchio" "$(cd "$T/jv/claude" && find . -type f | /usr/bin/grep -E '\.(bak|backup)')"
ok $([ -f "$T/jv/claude/setup/launchagents/com.jarvis.private-backup.plist" ] && echo 0 || echo 1) "com.jarvis.private-backup.plist c'e'"
n=$(cd "$T/jv/openclaw" && find . -type f | /usr/bin/grep -c -E '\.(bak|backup)')
ok $([ "$n" = 0 ] && echo 0 || echo 1) "nessun backup nello specchio di openclaw" "$(cd "$T/jv/openclaw" && find . -type f | /usr/bin/grep -E '\.(bak|backup)')"
ok $([ -f "$T/jv/openclaw/workflows/w.py" ] && echo 0 || echo 1) "workflows/w.py c'e'"

echo "2b. i test con dati restano fuori, gli altri no"
ok $([ ! -e "$T/jv/claude/hooks/wait-cap-guard-test.sh" ] && echo 0 || echo 1) "wait-cap-guard-test.sh fuori"
ok $([ ! -e "$T/jv/openclaw/tests/cron-health.test.mjs" ] && [ ! -e "$T/jv/openclaw/tests/cron-route.test.mjs" ] && [ ! -e "$T/jv/openclaw/tests/cron-when.test.mjs" ] && [ ! -e "$T/jv/openclaw/tests/scadenze-sync.test.mjs" ] && echo 0 || echo 1) "cron-health, cron-route, cron-when e scadenze-sync fuori"
ok $([ -f "$T/jv/openclaw/tests/stall-capture.test.mjs" ] && echo 0 || echo 1) "stall-capture.test.mjs c'e'"

echo "3. mutante: rsync sul vecchio elenco (con il file sparito) deve andare rosso"
# Il mutante e' il vecchio comando (elenco intero, exit 23 tollerato): rsync si ferma al primo mancante.
mut="$T/mutante.sh"
sed 's|^  rsync -a --files-from="$list.disk" "$src/" "$dst/"$|  rsync -a --files-from="$list" "$src/" "$dst/" \|\| [ $? = 23 ]|' "$S" > "$mut"
ok $(cmp -s "$mut" "$S" && echo 1 || echo 0) "il mutante differisce dall'originale"
git -C "$T/jv" rm -rq --cached claude >/dev/null 2>&1; trash "$T/jv/claude" 2>/dev/null
cp "$mut" "$T/jv/sync-public.sh"; run
ok $([ "$(cat "$T/jv/claude/hooks/d.sh" 2>/dev/null)" = d ] && echo 1 || echo 0) "col vecchio metodo d.sh non arriva" "(solo su macOS: l'arresto di rsync al primo file mancante)"

echo "4. un file di ~/.claude diventato cartella sul disco (non ancora committato): lo specchio non si blocca"
cp "$S" "$T/jv/sync-public.sh"; run   # riparto dallo specchio con lo script vero
rm "$H/.claude/hooks/e.sh"; mkdir "$H/.claude/hooks/e.sh"; echo dentro > "$H/.claude/hooks/e.sh/inner"
run; rc=$?
ok $rc "esce 0" "$(cat "$T/out")"
ok $([ -f "$T/jv/claude/hooks/e.sh" ] && [ "$(cat "$T/jv/claude/hooks/e.sh")" = e ] && echo 0 || echo 1) "e.sh e' il file di HEAD, la cartella del disco non e' passata"

echo "4b. clear_dst non esce dallo specchio"
mkdir -p "$T/jv/fuori"; echo vivo > "$T/jv/fuori/x"   # da $T/jv, claude/../fuori e' $T/jv/fuori: la sentinella sta dove il percorso arriva
( cd "$T/jv"; eval "$(sed -n '/^clear_dst() {/,/^}/p' "$S")"; clear_dst claude "../fuori" 2>/dev/null; echo $? > "$T/rc1"; clear_dst claude "/etc/x" 2>/dev/null; echo $? > "$T/rc2"; clear_dst "" "x" 2>/dev/null; echo $? > "$T/rc3" )
ok $([ "$(cat "$T/rc1")$(cat "$T/rc2")$(cat "$T/rc3")" = 111 ] && [ -f "$T/jv/fuori/x" ] && echo 0 || echo 1) "percorsi con .., assoluti o radice vuota: rifiutati, niente toccato"
# Il controllo sopra deve vedere un clear_dst che esce dallo specchio: senza la guardia sui percorsi la sentinella sparisce.
( cd "$T/jv"; eval "$(sed -n '/^clear_dst() {/,/^}/p' "$S" | sed '/^  case "\$2" in/d')"; clear_dst claude "../fuori" 2>/dev/null )
ok $([ ! -e "$T/jv/fuori/x" ] && echo 0 || echo 1) "senza la guardia sui percorsi, la sentinella viene cancellata (il controllo vede il mutante)"

echo "5. mutanti: senza clear_dst e senza il filtro backup di openclaw devono andare rossi"
mut="$T/mutante2.sh"
sed 's|^    clear_dst "$dst" "$f"$|    rm -f "$dst/$f"|' "$S" > "$mut"
ok $(cmp -s "$mut" "$S" && echo 1 || echo 0) "il mutante senza clear_dst differisce"
cp "$mut" "$T/jv/sync-public.sh"; git -C "$T/jv" rm -rq --cached claude >/dev/null 2>&1; trash "$T/jv/claude" 2>/dev/null; run; rc=$?
ok $([ "$rc" != 0 ] && echo 0 || echo 1) "col vecchio rm -f lo specchio si blocca (exit $rc)"
mut="$T/mutante3.sh"
sed '/^    | grep -v -E "\$BACKUP_RE" \\$/{x;s/^/x/;/^xx$/{x;d;};x;}' "$S" > "$mut"
ok $(cmp -s "$mut" "$S" && echo 1 || echo 0) "il mutante senza filtro backup in public_openclaw differisce"
cp "$mut" "$T/jv/sync-public.sh"; git -C "$T/jv" rm -rq --cached openclaw >/dev/null 2>&1; trash "$T/jv/openclaw" 2>/dev/null; run
n=$(cd "$T/jv/openclaw" 2>/dev/null && find . -type f | /usr/bin/grep -c -E '\.(bak|backup)')
ok $([ "${n:-0}" != 0 ] && echo 0 || echo 1) "senza il filtro i backup di openclaw passano nello specchio"

[ $fail = 0 ] && echo "sync-public-test: verde" || echo "sync-public-test: ROSSO"
exit $fail
