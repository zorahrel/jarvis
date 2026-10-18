#!/usr/bin/env bash
# Porta in questo repo PUBBLICO le parti in chiaro della config viva:
#   claude/    <- ~/.claude, solo i file che ai-config NON cifra (agenti, comandi, hook,
#                 script di setup, workflow). CLAUDE.md, memorie e skill proprie restano
#                 nel privato (private/, sottomodulo jarvis-private).
#   openclaw/  <- ~/.openclaw, solo workflow, test e script generici. Persona, rubrica e
#                 memoria di Jarvis stanno nel privato.
# Il controllo sui dati di persone vere lo fa push-guard al push, non questo script.
#
#   ./sync-public.sh            aggiorna e mostra cosa cambia
#   ./sync-public.sh --commit   aggiorna e committa (il push resta a mano)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

# File di ~/.claude non cifrati da git-crypt, esclusi quelli di regole git.
public_claude() {
  git -C "$HOME/.claude" ls-files -z | xargs -0 git -C "$HOME/.claude" check-attr filter -- \
    | awk -F': filter: ' '$2 != "git-crypt" {print $1}' \
    | grep -v -E '(^|/)\.git(ignore|attributes)$'
}

# Da OpenClaw solo cio' che non parla di persone: workflow, test e script del gateway.
public_openclaw() {
  git -C "$HOME/.openclaw" ls-files | grep -E '^(workflows|tests)/|^bin/stall-capture\.py$' | grep -v -E '\.jsonl$|^workflows/push\.py$'
}

mirror() { # $1 sorgente, $2 destinazione, stdin = elenco
  local src="$1" dst="$2" list; list=$(mktemp)
  cat > "$list"
  mkdir -p "$dst"
  ( cd "$dst" && find . \( -type f -o -type l \) | sed 's|^\./||' ) | sort > "$list.have"
  sort "$list" > "$list.want"
  comm -23 "$list.have" "$list.want" | while read -r f; do rm -f "$dst/$f"; done
  rsync -a --files-from="$list" "$src/" "$dst/"
  rm -f "$list" "$list.have" "$list.want"
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
