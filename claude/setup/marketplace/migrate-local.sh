#!/usr/bin/env bash
#
# Jarvis skills migration — one-shot.
#
# Moves custom skills from ~/.claude/skills/ (safetyCheck-protected) to
# ~/jarvis/skills-marketplace/ (writable from any Jarvis channel).
#
# Run this from your CLI (interactive claude CLI or a plain terminal).
# It's idempotent: safe to re-run if a step fails midway.
#
# Usage:
#   bash ~/jarvis/skills-marketplace/migrate.sh           # actually migrate
#   bash ~/jarvis/skills-marketplace/migrate.sh --dry-run # print plan only

set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

MP="$HOME/jarvis/skills-marketplace"
OLD="$HOME/.claude/skills"
REPO_SKILL_SRC="$HOME/.claude/jarvis/skills/jarvis-config"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi
step()  { printf "\n${BOLD}${BLUE}▸ %s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
info()  { printf "  ${DIM}%s${RESET}\n" "$1"; }
run()   { [ "$DRY" = "1" ] && printf "  ${DIM}[dry] %s${RESET}\n" "$*" || eval "$@"; }

# --- sanity ------------------------------------------------------------------
step "Pre-flight"

[ -f "$MP/.claude-plugin/marketplace.json" ] || {
  echo "✗ marketplace manifest missing at $MP/.claude-plugin/marketplace.json" >&2
  exit 1
}
ok "marketplace manifest present"

command -v claude >/dev/null 2>&1 || {
  echo "✗ claude CLI not found" >&2; exit 1
}
ok "claude CLI $(claude --version 2>/dev/null | head -1)"

# --- 0. Backup ---------------------------------------------------------------
step "Backing up ~/.claude/skills/"
BACKUP="$HOME/.claude/skills.backup-$(date +%Y%m%d-%H%M%S)"
if [ "$DRY" = "1" ]; then
  info "[dry] cp -R $OLD $BACKUP"
else
  cp -R "$OLD" "$BACKUP"
  ok "backup at $BACKUP"
fi

# --- 1. Move real-dir skills -------------------------------------------------
step "Moving custom skills into marketplace"
mkdir -p "$MP/skills"

for skill in reel-factory trend-research; do
  src="$OLD/$skill"
  dst="$MP/skills/$skill"
  if [ ! -d "$src" ] || [ -L "$src" ]; then
    info "$skill: source missing or is a symlink; skipping"
    continue
  fi
  if [ -e "$dst" ]; then
    warn "$skill: $dst already exists; skipping move"
    continue
  fi
  run mv "$src" "$dst"
  ok "moved $skill → $dst"
done

# --- 2. Symlink jarvis-config (stays in repo) --------------------------------
step "Linking jarvis-config from repo into marketplace"
link="$MP/skills/jarvis-config"
if [ -e "$link" ]; then
  info "symlink already exists; skipping"
elif [ -d "$REPO_SKILL_SRC" ]; then
  run ln -s "$REPO_SKILL_SRC" "$link"
  ok "linked $REPO_SKILL_SRC → $link"
else
  warn "jarvis-config source missing at $REPO_SKILL_SRC"
fi

# --- 3. Clean up stale entries in ~/.claude/skills/ --------------------------
step "Cleaning up ~/.claude/skills/"

# Old jarvis-config symlink (now served by the marketplace)
if [ -L "$OLD/jarvis-config" ]; then
  run rm "$OLD/jarvis-config"
  ok "removed stale $OLD/jarvis-config symlink"
fi

# Archived obsolete skills
if [ -d "$OLD/_archive" ]; then
  run rm -rf "$OLD/_archive"
  ok "removed $OLD/_archive"
fi

# --- 4. Register the marketplace ---------------------------------------------
step "Registering marketplace with Claude Code"

if claude plugin marketplace list 2>/dev/null | grep -q "^jarvis-skills\b"; then
  info "marketplace already registered"
else
  run claude plugin marketplace add "$MP"
  ok "marketplace registered"
fi

if claude plugin list 2>/dev/null | grep -q "jarvis-custom-skills"; then
  info "plugin already installed"
else
  run claude plugin install jarvis-custom-skills@jarvis-skills
  ok "plugin installed"
fi

# --- 5. Verify ---------------------------------------------------------------
step "Verifying"
info "running: claude plugin list"
claude plugin list 2>&1 | grep -E "jarvis|mp-" || true

step "Done"
cat <<EOF

${BOLD}${GREEN}Migration complete.${RESET}

Next:
  1. Test from CLI:   open Claude Code, type \`/\` — you should see
                      /jarvis-config, /reel-factory, /trend-research
  2. Test from Telegram: ask Jarvis to create a new skill. It should
                      write to $MP/skills/<name>/SKILL.md without errors.
  3. Restart the router if you changed dashboard code:
                      launchctl kickstart -k gui/\$(id -u)/com.jarvis.router

Rollback if needed:
  claude plugin uninstall jarvis-custom-skills@jarvis-skills
  claude plugin marketplace remove jarvis-skills
  mv $MP/skills/reel-factory $OLD/reel-factory
  mv $MP/skills/trend-research $OLD/trend-research
  ln -s $REPO_SKILL_SRC $OLD/jarvis-config
  cp -R $BACKUP/_archive $OLD/_archive  # if you had it

Backup preserved at: $BACKUP
EOF
