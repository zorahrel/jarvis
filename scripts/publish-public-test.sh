#!/bin/bash
# Barra di publish-public.sh: repo finti in una cartella temporanea, remoto = un repo bare locale
# (PUBLISH_REMOTE_URL). Mai il remoto vero, mai un push vero. push-guard e' quello vero, forzato
# (PUSH_GUARD=force) perche' un percorso locale non e' un repo GitHub.
# Uso: publish-public-test.sh [script]   (con un mutante come argomento: deve andare rosso)
set -u
S="${1:-$(dirname "$0")/publish-public.sh}"
S="$(cd "$(dirname "$S")" && pwd)/$(basename "$S")"
T=$(mktemp -d "${TMPDIR:-/tmp}/pubpub-test.XXXXXX")
fail=0
ok() { if [ "$1" = 0 ]; then echo "  ✓ $2"; else echo "  ✗ $2${3:+ — $3}"; fail=1; fi; }
trap 'trash "$T" 2>/dev/null' EXIT

# Un'email che non e' di nessuno dei segnaposto che push-guard lascia passare. Spezzata nel sorgente,
# perche' questo file va in pubblico e push-guard la fermerebbe.
MAIL="persona.vera""@azienda-prova.it"

g() { git -c user.name=Test -c user.email=test@example.com "$@"; }

# $1 = nome dello scenario. Crea $T/$1/{remote.git,live}: il remoto ha un commit E gia' pubblicato,
# live ha una storia sua (come main vivo: il pubblicato e' un filtrato, non un suo antenato)
# con due percorsi esclusi, e refs/public/synced punta a E.
scenario() {
  local D="$T/$1"
  mkdir -p "$D"
  git init -q --bare -b main "$D/remote.git"
  git init -q -b main "$D/seed"
  mkdir -p "$D/seed/scripts"
  echo uno > "$D/seed/a.txt"; cp "$S" "$D/seed/scripts/publish-public.sh"
  g -C "$D/seed" add -A; g -C "$D/seed" commit -q -m "base pubblica"
  g -C "$D/seed" push -q "$D/remote.git" main 2>/dev/null
  git init -q -b main "$D/live"
  mkdir -p "$D/live/scripts" "$D/live/tools/usage-hub" "$D/live/scripts/riavvio-app-sessioni" "$D/live/mcp-servers/edm-mail" "$D/live/mcp-servers/gateway"
  cp "$S" "$D/live/scripts/publish-public.sh"
  echo uno > "$D/live/a.txt"
  echo fixture > "$D/live/tools/usage-hub/f.txt"
  echo una-tantum > "$D/live/scripts/riavvio-app-sessioni/run.sh"
  echo casella > "$D/live/mcp-servers/edm-mail/index.mjs"
  echo figli > "$D/live/mcp-servers/gateway/gateway-config.json"
  g -C "$D/live" add -A; g -C "$D/live" commit -q -m "storia vecchia"
  git -C "$D/live" fetch -q "$D/remote.git" main
  git -C "$D/live" update-ref refs/public/synced "$(git -C "$D/remote.git" rev-parse main)"
}
run() { # $1 scenario, resto = argomenti; stdout+stderr in $T/$1/out
  local D="$T/$1"; shift
  PUBLISH_REMOTE_URL="$D/remote.git" PUSH_GUARD=force bash "$D/live/scripts/publish-public.sh" "$@" > "$D/out" 2>&1
}
head_of() { git -C "$T/$1/remote.git" rev-parse main; }

echo "1. un commit intermedio con un'email vera, poi tolta: verde e un commit solo"
scenario a
E=$(head_of a)
echo "$MAIL" > "$T/a/live/a.txt"; g -C "$T/a/live" commit -qam "aggiungo contatto"
echo due > "$T/a/live/a.txt"; g -C "$T/a/live" commit -qam "tolgo contatto"
run a --dry-run --list "$T/a/lista"; rc=$?
ok $rc "dry-run esce 0" "$(cat "$T/a/out")"
ok $([ "$(head_of a)" = "$E" ] && echo 0 || echo 1) "il dry-run non muove il remoto"
ok $([ "$(cat "$T/a/lista" 2>/dev/null)" = "$(printf 'M\ta.txt')" ] && echo 0 || echo 1) "la lista dice solo M a.txt" "$(cat "$T/a/lista" 2>/dev/null)"
run a; rc=$?
ok $rc "il push (sul remoto finto) esce 0" "$(cat "$T/a/out")"
ok $([ "$(git -C "$T/a/remote.git" rev-list --count "$E..main")" = 1 ] && echo 0 || echo 1) "sul remoto c'e' un commit solo"
ok $(git -C "$T/a/remote.git" log -p main | /usr/bin/grep -q "$MAIL" && echo 1 || echo 0) "l'email non e' nel remoto"
msg=$(git -C "$T/a/remote.git" log -1 --format=%B main)
ok $(echo "$msg" | /usr/bin/grep -q "tolgo contatto\|aggiungo contatto" && echo 1 || echo 0) "il messaggio non porta i soggetti locali" "$msg"
ok $([ "$(git -C "$T/a/live" rev-parse refs/public/synced)" = "$(head_of a)" ] && echo 0 || echo 1) "refs/public/synced punta al commit pubblicato"
[ -x "$T/a/live/.git/hooks/pre-push" ] && /usr/bin/grep -q 'riavvio-app-sessioni' "$T/a/live/.git/hooks/pre-push"
ok $? "l'hook pre-push conosce entrambi gli esclusi"

echo "2. mutante: pubblicare la storia intera (non il commit solo) deve andare rosso"
mut="$T/mutante.sh"
sed 's|^out="$(git commit-tree .*|out="$TIP"|' "$S" > "$mut"
ok $(cmp -s "$mut" "$S" && echo 1 || echo 0) "il mutante differisce dall'originale"
scenario m; cp "$mut" "$T/m/live/scripts/publish-public.sh"
echo "$MAIL" > "$T/m/live/a.txt"; g -C "$T/m/live" commit -qam "aggiungo contatto"
echo due > "$T/m/live/a.txt"; g -C "$T/m/live" commit -qam "tolgo contatto"
run m --dry-run; rc=$?
ok $([ $rc != 0 ] && echo 0 || echo 1) "col vecchio metodo push-guard ferma (exit $rc)"

echo "3. l'email e' ancora nell'albero finale: rosso, remoto fermo"
scenario b
E=$(head_of b)
echo "$MAIL" > "$T/b/live/a.txt"; g -C "$T/b/live" commit -qam "contatto"
run b; rc=$?
ok $([ $rc = 1 ] && echo 0 || echo 1) "esce 1" "exit $rc: $(cat "$T/b/out")"
ok $([ "$(head_of b)" = "$E" ] && echo 0 || echo 1) "il remoto non si muove"

echo "4. i percorsi esclusi non arrivano al remoto"
scenario c
echo nuovo > "$T/c/live/b.txt"; echo altro >> "$T/c/live/tools/usage-hub/f.txt"
echo altro >> "$T/c/live/scripts/riavvio-app-sessioni/run.sh"
# Backup di ogni forma, anche in scripts/ e come cartella: non escono. Il plist con "-backup." non e' un backup.
mkdir -p "$T/c/live/scripts/x.bak"
for f in scripts/t.sh.bak scripts/t.sh.bak-2026-10-18 scripts/t.sh.bak_old scripts/t.sh.bak2 scripts/t.backup scripts/x.bak/f; do echo copia > "$T/c/live/$f"; done
echo plist > "$T/c/live/private-backup.plist"
g -C "$T/c/live" add -A; g -C "$T/c/live" commit -qm "novita"
run c --dry-run --list "$T/c/lista"
ok $([ "$(cat "$T/c/lista")" = "$(printf 'A\tb.txt\nA\tprivate-backup.plist')" ] && echo 0 || echo 1) "la lista dice solo A b.txt e il plist" "$(cat "$T/c/lista")"
run c
files=$(git -C "$T/c/remote.git" ls-tree -r --name-only main | tr '\n' ' ')
ok $([ "$files" = "a.txt b.txt private-backup.plist scripts/publish-public.sh " ] && echo 0 || echo 1) "nel remoto non ci sono ne' gli esclusi ne' i backup" "$files"

echo "5. secondo giro senza novita': nessun commit"
H=$(head_of c)
echo ancora >> "$T/c/live/tools/usage-hub/f.txt"; g -C "$T/c/live" commit -qam "solo escluso"
run c; rc=$?
ok $rc "esce 0" "$(cat "$T/c/out")"
ok $([ "$(head_of c)" = "$H" ] && echo 0 || echo 1) "il remoto non si muove"
ok $(/usr/bin/grep -q 'niente di nuovo' "$T/c/out" && echo 0 || echo 1) "dice «niente di nuovo»"

echo "6. secondo giro con una novita': fast-forward"
echo tre > "$T/c/live/c.txt"; g -C "$T/c/live" add c.txt; g -C "$T/c/live" commit -qm "altra novita"
run c; rc=$?
ok $rc "esce 0" "$(cat "$T/c/out")"
git -C "$T/c/remote.git" merge-base --is-ancestor "$H" main
ok $? "il nuovo head discende dal vecchio"
ok $([ "$(git -C "$T/c/remote.git" rev-list --count "$H..main")" = 1 ] && echo 0 || echo 1) "un commit in piu'"

echo "7. il remoto si e' mosso da solo: si ferma"
scenario d
echo estranea > "$T/d/seed/x.txt"; g -C "$T/d/seed" add x.txt; g -C "$T/d/seed" commit -qm "push a mano"
g -C "$T/d/seed" push -q "$T/d/remote.git" main 2>/dev/null
M=$(head_of d)
echo due > "$T/d/live/a.txt"; g -C "$T/d/live" commit -qam "novita"
run d; rc=$?
ok $([ $rc = 2 ] && echo 0 || echo 1) "esce 2" "exit $rc: $(cat "$T/d/out")"
ok $([ "$(head_of d)" = "$M" ] && echo 0 || echo 1) "il remoto resta com'e'"

echo "8. --list con percorso relativo: il file c'e' davvero, anche se lo script fa cd nel clone"
scenario e
echo nuovo > "$T/e/live/b.txt"; g -C "$T/e/live" add b.txt; g -C "$T/e/live" commit -qm "novita"
( cd "$T/e" && PUBLISH_REMOTE_URL="$T/e/remote.git" PUSH_GUARD=force bash live/scripts/publish-public.sh --dry-run --list lista-rel > "$T/e/out" 2>&1 ); rc=$?
ok $rc "esce 0" "$(cat "$T/e/out")"
ok $([ "$(cat "$T/e/lista-rel" 2>/dev/null)" = "$(printf 'A\tb.txt')" ] && echo 0 || echo 1) "lista-rel e' nella cartella da cui l'ho lanciato" "$(cat "$T/e/lista-rel" 2>/dev/null)"

echo "9. --dry-run con un'email nell'albero: esce 1 (push-guard ferma anche senza push)"
scenario f
echo "$MAIL" > "$T/f/live/a.txt"; g -C "$T/f/live" commit -qam "contatto"
run f --dry-run; rc=$?
ok $([ $rc = 1 ] && echo 0 || echo 1) "esce 1" "exit $rc: $(cat "$T/f/out")"
# Controprova: senza la chiamata a push-guard lo stesso dry-run esce 0, quindi questo scenario la vede.
mut2="$T/mutante-pg.sh"
/usr/bin/grep -v 'push-guard" origin' "$S" > "$mut2"
ok $(cmp -s "$mut2" "$S" && echo 1 || echo 0) "il mutante differisce dall'originale"
cp "$mut2" "$T/f/live/scripts/publish-public.sh"; run f --dry-run; rc=$?
ok $([ $rc = 0 ] && echo 0 || echo 1) "senza push-guard esce 0 (il punto 9 lo vedrebbe rosso)" "exit $rc"
# Il mutante `git push -f` non si vede da qui: servirebbe un remoto che si muove fra il controllo e il push
# (una gara finta). Il fast-forward e' garantito dal controllo sul remoto qui sopra (scenario 7), non dal flag.

echo "10. l'hook pre-push ferma un push degli esclusi verso il remoto pubblico, in https e in ssh"
scenario h
run h --dry-run
hook="$T/h/live/.git/hooks/pre-push"; sha=$(git -C "$T/h/live" rev-parse main)
for url in https://github.com/zorahrel/jarvis.git git@github.com:zorahrel/jarvis.git ssh://git@github.com/zorahrel/jarvis.git; do
  echo "refs/heads/main $sha refs/heads/main 0000000000000000000000000000000000000000" | (cd "$T/h/live" && sh "$hook" origin "$url") >/dev/null 2>&1; rc=$?
  ok $([ $rc = 1 ] && echo 0 || echo 1) "ferma $url" "exit $rc"
done
echo "refs/heads/main $sha refs/heads/main 0000000000000000000000000000000000000000" | (cd "$T/h/live" && sh "$hook" origin git@github.com:altro/repo.git) >/dev/null 2>&1; rc=$?
ok $rc "lascia passare un altro remoto"

echo "11. l'hook riconosce lo stesso repo scritto con maiuscole o con barra finale"
for url in https://github.com/Zorahrel/Jarvis.git https://github.com/zorahrel/jarvis/ https://github.com/zorahrel/jarvis.git/ git@github.com:ZORAHREL/JARVIS.git; do
  echo "refs/heads/main $sha refs/heads/main 0000000000000000000000000000000000000000" | (cd "$T/h/live" && sh "$hook" origin "$url") >/dev/null 2>&1; rc=$?
  ok $([ $rc = 1 ] && echo 0 || echo 1) "ferma $url" "exit $rc"
done
mut3="$T/mutante3-hook.sh"
sed 's#^u=.*$#u="\\$2"#' "$S" > "$mut3"
ok $(cmp -s "$mut3" "$S" && echo 1 || echo 0) "il mutante senza normalizzazione differisce"
scenario i; cp "$mut3" "$T/i/live/scripts/publish-public.sh"; run i --dry-run
echo "refs/heads/main $sha refs/heads/main 0000000000000000000000000000000000000000" | (cd "$T/i/live" && sh "$T/i/live/.git/hooks/pre-push" origin https://github.com/Zorahrel/Jarvis.git) >/dev/null 2>&1; rc=$?
ok $([ $rc = 0 ] && echo 0 || echo 1) "col vecchio confronto l'URL maiuscolo passa (il punto 11 lo vedrebbe rosso)" "exit $rc"

echo "12. un backup resta nell'albero (tolto il passo che li toglie) in un albero grande: si ferma con exit 1"
# Albero oltre il buffer della pipe (64 KB di nomi) e backup in testa all'elenco: e' il caso in cui grep -q usciva
# per primo, ls-tree prendeva SIGPIPE e il controllo, con pipefail, taceva.
scenario j
mkdir -p "$T/j/live/zz"
for i in $(seq 1 1500); do : > "$T/j/live/zz/file-di-prova-con-un-nome-lungo-per-riempire-la-pipe-$i.txt"; done
echo copia > "$T/j/live/a.bak"; g -C "$T/j/live" add -A; g -C "$T/j/live" commit -qm "albero grande con un backup"
mut4="$T/mutante-nobk.sh"
/usr/bin/grep -v 'pathspec-from-file=-' "$S" > "$mut4"
ok $(cmp -s "$mut4" "$S" && echo 1 || echo 0) "il mutante senza il passo che toglie i backup differisce"
cp "$mut4" "$T/j/live/scripts/publish-public.sh"; run j --status; rc=$?
ok $([ $rc = 1 ] && /usr/bin/grep -q "un backup e' ancora" "$T/j/out" && echo 0 || echo 1) "il controllo vede il backup rimasto: exit 1" "exit $rc: $(tail -2 "$T/j/out")"
# Controprova: con il vecchio grep -q lo stesso scenario passa in silenzio (exit 0), quindi questo lo vede rosso.
mut5="$T/mutante-grepq.sh"
sed 's|/usr/bin/grep -E "\$BACKUP_RE" >/dev/null|/usr/bin/grep -q -E "$BACKUP_RE"|' "$mut4" > "$mut5"
ok $(cmp -s "$mut5" "$mut4" && echo 1 || echo 0) "il mutante col vecchio grep -q differisce"
cp "$mut5" "$T/j/live/scripts/publish-public.sh"; run j --status; rc=$?
ok $([ $rc = 0 ] && echo 0 || echo 1) "col vecchio grep -q il backup passa in silenzio (il punto 12 lo vedrebbe rosso)" "exit $rc"

[ $fail = 0 ] && echo "publish-public-test: verde" || echo "publish-public-test: ROSSO"
exit $fail
