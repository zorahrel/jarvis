#!/usr/bin/env bash
# Pubblica su origin/main (repo PUBBLICO zorahrel/jarvis) l'albero di main SENZA i percorsi esclusi.
#
# Ogni pubblicazione e' UN commit solo: l'albero finale di main meno gli esclusi, genitore l'ultimo
# commit del remoto. Perche': push-guard legge le righe aggiunte da OGNI commit fra il remoto e quello
# che si pusha, quindi un dato messo e poi tolto in un commit successivo resta "aggiunto" e ferma il
# push per sempre, e riscrivere main vivo non si puo' (altre sessioni vi committano). Con un commit
# solo conta cio' che e' davvero nell'albero. Il messaggio porta solo la data: i soggetti dei commit
# di main possono contenere nomi.
#
#   scripts/publish-public.sh --status                 quanti file cambierebbe in pubblico
#   scripts/publish-public.sh --dry-run [--list F]     costruisce il commit, lo controlla con push-guard, senza push
#   scripts/publish-public.sh [--list F]               come sopra, poi push (mai force)
#
# --list F scrive in F l'elenco esatto di cio' che cambia in pubblico (git diff --name-status remoto commit).
# PUBLISH_REMOTE_URL sostituisce il remoto (default: origin): lo usa il test, con repo finti.
#
# Come: clone bare in una cartella temporanea (il checkout vivo non si tocca) e un commit-tree.
# `refs/public/synced` (locale, mai pushato) = il commit che questo script ha pushato per ultimo:
# se il remoto e' altrove, qualcuno ha pushato a mano e lo script si ferma. Si aggiorna solo a push riuscito.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Percorsi di main che non vanno mai nel pubblico, ciascuno col suo perche'.
EXCLUDE=(
  # fixture con email vere, token finti nei test; resta qui con la sua storia e nel backup cifrato del privato
  "tools/usage-hub"
  # script una tantum con identificativi dell'app Claude, account e cartelle di clienti
  "scripts/riavvio-app-sessioni"
  # server di una casella di lavoro: nome e dominio nel codice non servono a chi legge, resta su questo Mac
  "mcp-servers/edm-mail"
  # la configurazione viva del gateway, con l'elenco dei server di questo Mac
  "mcp-servers/gateway/gateway-config.json"
)
# Backup (.bak, .bak2, .bak_old, .backup, anche cartelle x.bak/): copie in chiaro di file cifrati nel repo.
# Stessa regola di sync-public.sh, qui applicata a tutto l'albero, scripts/ compreso.
BACKUP_RE='\.(bak|backup)([^a-zA-Z]|$)'
SYNCED="refs/public/synced"
LIVE="$(cd "$(dirname "$0")/.." && pwd)"
URL="${PUBLISH_REMOTE_URL:-$(git -C "$LIVE" remote get-url origin)}"
mode="push"; list=""
while [ $# -gt 0 ]; do
  case "$1" in
    --status|--dry-run) mode="$1" ;;
    --list) shift; list="${1:?--list vuole un file}" ;;
    *) echo "publish-public: argomento sconosciuto: $1" >&2; exit 2 ;;
  esac
  shift
done
# --list e' relativo a dove sei adesso: lo script piu' sotto fa cd nel clone e il trap lo cancella.
[ -z "$list" ] || case "$list" in /*) ;; *) list="$PWD/$list" ;; esac

# Rete di sicurezza: un `git push` nudo da main porterebbe fuori gli esclusi appena push-guard non
# trova piu' dati nelle fixture. L'hook lo ferma se un commit da pushare a questo remoto ne contiene uno.
# L'URL si confronta in minuscolo e senza barra finale: GitHub li accetta entrambi per lo stesso repo.
install_guard() {
  local hook="$LIVE/.git/hooks/pre-push" want
  want="$(cat <<HOOK
#!/bin/sh
# Installato da scripts/publish-public.sh: il repo pubblico non porta questi percorsi.
u=\$(printf '%s' "\$2" | tr 'A-Z' 'a-z' | sed 's|/*\$||')
case "\$u" in *[/:]zorahrel/jarvis.git|*[/:]zorahrel/jarvis) ;; *) exit 0 ;; esac
while read -r lref lsha rref rsha; do
  case "\$lsha" in 0000000*) continue ;; esac
  for p in ${EXCLUDE[*]}; do
    if git cat-file -e "\$lsha:\$p" 2>/dev/null; then
      echo "[pre-push] \$lref contiene \$p: il repo pubblico non lo porta." >&2
      echo "           Pubblica con scripts/publish-public.sh (spinge un commit solo, senza)." >&2
      exit 1
    fi
  done
done
exit 0
HOOK
)"
  [ "$(cat "$hook" 2>/dev/null)" = "$want" ] && return 0
  printf '%s\n' "$want" > "$hook"; chmod +x "$hook"
}

# Il remoto, riletto dal remoto vero (non dal tracking locale, che puo' essere vecchio).
remote_head() { git ls-remote "$URL" refs/heads/main | cut -f1; }

install_guard
E="$(remote_head)"
[ -n "$E" ] || { echo "publish-public: ls-remote non risponde" >&2; exit 2; }
S="$(git -C "$LIVE" rev-parse -q --verify "$SYNCED" || true)"
[ -n "$S" ] || { echo "publish-public: manca $SYNCED: se il remoto ($E) e' quello giusto, git update-ref $SYNCED $E" >&2; exit 2; }
[ "$S" = "$E" ] || { echo "publish-public: il remoto ($E) non e' l'ultimo che ho pubblicato io ($S): qualcuno ha pushato a mano, guardalo" >&2; exit 2; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
git clone -q --bare "$LIVE" "$work/c.git"
cd "$work/c.git"
git config user.name "$(git -C "$LIVE" config user.name)"; git config user.email "$(git -C "$LIVE" config user.email)"
git fetch -q "$URL" "refs/heads/main:refs/remotes/pub/main"
[ "$(git rev-parse refs/remotes/pub/main)" = "$E" ] || { echo "publish-public: il remoto si e' mosso durante il giro, riprova" >&2; exit 2; }

# Albero finale di main meno gli esclusi e i backup.
TIP="$(git rev-parse main)"
export GIT_INDEX_FILE="$work/idx"
git read-tree "$TIP"; git rm -r -q --cached --ignore-unmatch "${EXCLUDE[@]}"
backups="$(git ls-tree -r --name-only "$TIP" | /usr/bin/grep -E "$BACKUP_RE" || true)"
[ -z "$backups" ] || printf '%s\n' "$backups" | git rm -q --cached --ignore-unmatch --pathspec-from-file=-
tree="$(git write-tree)"; unset GIT_INDEX_FILE
for p in "${EXCLUDE[@]}"; do
  ! git cat-file -e "$tree:$p" 2>/dev/null || { echo "publish-public: $p e' ancora nell'albero da pubblicare" >&2; exit 1; }
done

# Senza -q: grep legge tutto l'elenco. Con -q esce al primo trovato, ls-tree prende SIGPIPE, la pipe vale 141 sotto
# pipefail e il "!" la gira in "ok": il controllo taceva proprio quando c'era un backup.
! git ls-tree -r --name-only "$tree" | /usr/bin/grep -E "$BACKUP_RE" >/dev/null || { echo "publish-public: un backup e' ancora nell'albero da pubblicare" >&2; exit 1; }

if [ "$tree" = "$(git rev-parse "$E^{tree}")" ]; then
  [ -z "$list" ] || : > "$list"
  echo "publish-public: niente di nuovo."; exit 0
fi
out="$(git commit-tree "$tree" -p "$E" -m "Aggiornamento del repo pubblico del $(date +%F)")"
changed="$(git diff --no-renames --name-status "$E" "$out")"
[ -z "$list" ] || printf '%s\n' "$changed" > "$list"
echo "publish-public: $(printf '%s\n' "$changed" | wc -l | tr -d ' ') file cambiano in pubblico"
[ "$mode" = "--status" ] && exit 0

echo "refs/heads/main $out refs/heads/main $E" | "$HOME/bin/push-guard" origin "$URL"
echo "publish-public: push-guard verde"
[ "$mode" = "--dry-run" ] && exit 0
git push -q "$URL" "$out:refs/heads/main"
# Il commit nasce nel clone: lo porto nel repo vivo prima di puntarvi il ref.
git update-ref refs/publish/out "$out"
git -C "$LIVE" fetch -q "$work/c.git" refs/publish/out
git -C "$LIVE" update-ref "$SYNCED" "$out"
echo "publish-public: pubblicato $(git rev-parse --short "$out") (main vivo $(git rev-parse --short "$TIP"))"
