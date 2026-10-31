#!/usr/bin/env bash
# Porta in questo repo PUBBLICO le parti in chiaro della config viva:
#   claude/    <- ~/.claude, solo i file che ai-config NON cifra (agenti, comandi, hook,
#                 script di setup, workflow). CLAUDE.md, memorie e skill proprie restano
#                 nel privato (private/, sottomodulo jarvis-private).
#   openclaw/  <- ~/.openclaw, solo workflow, test e script generici. Persona, rubrica e
#                 memoria di Jarvis stanno nel privato.
# Il controllo sui dati di persone vere lo fa push-guard al push, non questo script.
# tools/usage-hub non va mai nel pubblico (27/10): qui e' escluso da public_claude, e il push
# di jarvis passa da scripts/publish-public.sh, che spinge main senza quella cartella.
#
#   ./sync-public.sh            aggiorna e mostra cosa cambia
#   ./sync-public.sh --commit   aggiorna e committa (il push resta a mano)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

# Percorsi di un repo come sono committati in HEAD (non come stanno sul disco): lo specchio porta
# solo il committato, una modifica in corso di un'altra sessione non deve finire in pubblico.
committed() { git -C "$1" ls-tree -r -z --name-only HEAD; }

# Link simbolici con percorso assoluto (/Users/...): fuori dal Mac non portano da nessuna parte.
abs_links() {
  git -C "$1" ls-tree -r HEAD | awk -F'\t' '{split($1, m, " "); if (m[1] == "120000") print m[3] "\t" $2}' \
    | while IFS=$'\t' read -r sha path; do
        case "$(git -C "$1" cat-file blob "$sha")" in /*) printf '%s\n' "$path" ;; esac
      done
}

# Backup: .bak, .bak.DATA, .bak-NOME, .bak_old, .bak2, .backup, anche come cartella (x.bak/). Sono copie in
# chiaro di file che nel repo sono cifrati. com.jarvis.private-backup.plist non c'entra: il punto prima di
# "bak" manca. La stessa regola e' in scripts/publish-public.sh, che esclude anche i file di scripts/.
BACKUP_RE='\.(bak|backup)([^a-zA-Z]|$)'

# File di ~/.claude non cifrati da git-crypt, esclusi quelli di regole git, i backup e i link con percorso assoluto.
public_claude() {
  committed "$HOME/.claude" | xargs -0 git -C "$HOME/.claude" check-attr filter -- \
    | awk -F': filter: ' '$2 != "git-crypt" {print $1}' \
    | grep -v -E '(^|/)\.git(ignore|attributes)$|^setup/bin/aac$|^hooks/wait-cap-guard-test\.sh$|(^|/)usage-hub(/|$)' \
    | grep -v -E "$BACKUP_RE" \
    | /usr/bin/grep -v -x -F -f <(abs_links "$HOME/.claude")
}

# Da OpenClaw solo cio' che non parla di persone: workflow, test e script del gateway.
# scadenze-sync.test.mjs ha un nome di persona, un progetto di un cliente e il suo dominio; cron-health,
# cron-route e cron-when portano un nome di progetto. In pubblico nessuno dei quattro gira: importano
# file che lo specchio non porta.
# hooks/wait-cap-guard-test.sh (sopra, in public_claude) porta comandi veri di sessioni, con identificativi.
public_openclaw() {
  committed "$HOME/.openclaw" | tr '\0' '\n' | grep -E '^(workflows|tests)/|^bin/stall-capture\.py$' \
    | grep -v -E '\.jsonl$|^workflows/push(-mac)?\.py$|^tests/(scadenze-sync|cron-health|cron-route|cron-when)\.test\.mjs$' \
    | grep -v -E "$BACKUP_RE" \
    | /usr/bin/grep -v -x -F -f <(abs_links "$HOME/.openclaw")
}

# Lo specchio e' generato: dove sul disco un file e' diventato cartella, rsync l'ha copiata e `rm -f` esce 1 fermando
# tutto finche' qualcuno non la toglie a mano. Qui si toglie file o cartella, ma solo se il percorso sta dentro lo specchio.
clear_dst() { # $1 radice dello specchio, $2 percorso relativo
  case "$1" in ""|/) return 1 ;; esac
  case "$2" in ""|/*|..|../*|*/..|*/../*) echo "sync-public: percorso fuori dallo specchio: $2" >&2; return 1 ;; esac
  rm -rf -- "$1/$2"
}

mirror() { # $1 sorgente, $2 destinazione, stdin = elenco
  local src="$1" dst="$2" list; list=$(mktemp)
  cat > "$list"
  mkdir -p "$dst"
  ( cd "$dst" && find . \( -type f -o -type l \) | sed 's|^\./||' ) | sort > "$list.have"
  sort "$list" > "$list.want"
  comm -23 "$list.have" "$list.want" | while read -r f; do rm -f "$dst/$f"; done
  # A rsync solo cio' che esiste sul disco: su macOS, davanti a un file sparito (cancellato e non ancora
  # committato) smette di copiare il resto della lista. I mancanti li porta il giro sotto, da HEAD.
  while IFS= read -r f; do
    if [ -e "$src/$f" ] || [ -L "$src/$f" ]; then printf '%s\n' "$f"; fi
  done < "$list.want" > "$list.disk"
  rsync -a --files-from="$list.disk" "$src/" "$dst/"
  # Per i file con modifiche non committate, o spariti dal disco, vale HEAD.
  git -C "$src" diff --name-only -z HEAD | while IFS= read -r -d '' f; do
    /usr/bin/grep -q -x -F -- "$f" "$list.want" || continue
    mode="$(git -C "$src" ls-tree HEAD -- "$f" | cut -d' ' -f1)"
    clear_dst "$dst" "$f"
    [ -n "$mode" ] || continue
    mkdir -p "$dst/$(dirname "$f")"
    if [ "$mode" = 120000 ]; then ln -s "$(git -C "$src" cat-file blob "HEAD:$f")" "$dst/$f"
    else
      git -C "$src" cat-file blob "HEAD:$f" > "$dst/$f"
      if [ "$mode" = 100755 ]; then chmod +x "$dst/$f"; fi
    fi
  done
  rm -f "$list" "$list.have" "$list.want" "$list.disk"
}

public_claude | mirror "$HOME/.claude" claude
public_openclaw | mirror "$HOME/.openclaw" openclaw

git add -A claude openclaw
if git diff --cached --quiet -- claude openclaw; then echo "sync-public: niente di nuovo."; exit 0; fi
git diff --cached --stat -- claude openclaw | tail -3
if [ "${1:-}" = "--commit" ]; then
  git commit -q -m "sync-public: $(date '+%Y-%m-%d %H:%M') dalla config viva" -- claude openclaw
  echo "sync-public: committato. Push a mano: push-guard controlla i dati di persone."
fi
