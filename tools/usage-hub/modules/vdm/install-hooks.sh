#!/usr/bin/env bash
# install-hooks.sh — [BETA] Shared hook installer for token usage tracking
# Sourced by install.sh, uninstall.sh, and vdm upgrade.
# Provides: install_beta_hooks(), uninstall_beta_hooks()
#
# Two hooks are installed:
# 1. Claude Code hooks in ~/.claude/settings.json (UserPromptSubmit + Stop)
# 2. Global git prepare-commit-msg hook for token usage trailers

# Detect dashboard port (respect CSW_PORT env var)
_VDM_PORT="${CSW_PORT:-3333}"
_VDM_HOOKS_MARKER="# vdm-token-usage"
_VDM_HOOKS_PATH_MARKER=".vdm-set-hooks-path"
# This file is sourced, so BASH_SOURCE — not $0 — names it.
_VDM_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vdm-helper.mjs"

install_beta_hooks() {
  _install_claude_code_hooks
  _install_git_hook
}

uninstall_beta_hooks() {
  _uninstall_claude_code_hooks
  _uninstall_git_hook
}

# ─────────────────────────────────────────────────
# Claude Code hooks (~/.claude/settings.json)
# ─────────────────────────────────────────────────

_install_claude_code_hooks() {
  local settings_dir="$HOME/.claude"
  mkdir -p "$settings_dir" 2>/dev/null || true

  # The JSON surgery lives in vdm-helper.mjs. It was inline `python3 -c` with
  # the settings path interpolated into the source, which made python3 a hard
  # dependency it does not need — Node is already required — and broke on any
  # home directory containing a quote.
  if ! "${VDM_NODE:-node}" "$_VDM_HELPER" hooks-install "$settings_dir/settings.json" "$_VDM_PORT"; then
    echo -e "  ${YELLOW:-}Warning: Failed to install Claude Code hooks${NC:-}" >&2
    return 1
  fi
}

_uninstall_claude_code_hooks() {
  local settings_file="$HOME/.claude/settings.json"
  [[ -f "$settings_file" ]] || return 0

  if ! "${VDM_NODE:-node}" "$_VDM_HELPER" hooks-uninstall "$settings_file" "$_VDM_PORT"; then
    echo -e "  ${YELLOW:-}Warning: Failed to uninstall Claude Code hooks${NC:-}" >&2
    return 1
  fi
}

# ─────────────────────────────────────────────────
# Global git prepare-commit-msg hook
# ─────────────────────────────────────────────────

_install_git_hook() {
  local hooks_dir=""
  local we_set_hooks_path=false

  # Determine hooks directory
  hooks_dir=$(git config --global core.hooksPath 2>/dev/null) || true

  if [[ -z "$hooks_dir" ]]; then
    hooks_dir="$HOME/.config/git/hooks"
    mkdir -p "$hooks_dir" 2>/dev/null || true
    git config --global core.hooksPath "$hooks_dir" 2>/dev/null || true
    # Write marker so uninstall knows we set it
    touch "$hooks_dir/$_VDM_HOOKS_PATH_MARKER" 2>/dev/null || true
    we_set_hooks_path=true
  else
    # Expand ~ in path
    hooks_dir="${hooks_dir/#\~/$HOME}"
    mkdir -p "$hooks_dir" 2>/dev/null || true
  fi

  local hook_file="$hooks_dir/prepare-commit-msg"

  # If our hook is already installed, remove it so we can write the latest version
  if [[ -f "$hook_file" ]] && grep -q "$_VDM_HOOKS_MARKER" "$hook_file" 2>/dev/null; then
    rm -f "$hook_file" 2>/dev/null || true
  fi

  # If existing hook without our marker, move aside
  if [[ -f "$hook_file" ]] && ! grep -q "$_VDM_HOOKS_MARKER" "$hook_file" 2>/dev/null; then
    mv "$hook_file" "${hook_file}.vdm-original" 2>/dev/null || true
  fi

  # Write our hook. VDM_NODE/VDM_HELPER are baked in at install time: a git hook
  # runs with a minimal environment and, on Windows, through Git's own sh, so
  # neither the user's PATH nor this script's directory can be assumed.
  cat > "$hook_file" << HOOKEOF
#!/bin/sh
VDM_NODE="${VDM_NODE:-node}"
VDM_HELPER="$_VDM_HELPER"
HOOKEOF
  cat >> "$hook_file" << 'HOOKEOF'
# vdm-token-usage
# [BETA] Appends token usage trailer to commit messages.
# Part of claude-acct-switcher (https://github.com/loekj/claude-acct-switcher)

# Chain to repo-local hook (core.hooksPath disables .git/hooks/)
LOCAL_HOOK="$(git rev-parse --git-dir 2>/dev/null)/hooks/prepare-commit-msg"
[ -x "$LOCAL_HOOK" ] && [ "$LOCAL_HOOK" != "$0" ] && { "$LOCAL_HOOK" "$@" || exit $?; }

# Chain to pre-existing global hook we moved aside
[ -x "${0}.vdm-original" ] && { "${0}.vdm-original" "$@" || exit $?; }

# Skip merge/squash/amend
case "$2" in merge|squash|commit) exit 0 ;; esac

# Check if commitTokenUsage is enabled (disabled by default; silent fail = skip)
VDM_PORT="${CSW_PORT:-3333}"
SETTINGS=$(curl -s --max-time 2 "http://localhost:${VDM_PORT}/api/settings" 2>/dev/null) || true
if ! printf '%s' "$SETTINGS" | "$VDM_NODE" "$VDM_HELPER" commit-tokens-enabled 2>/dev/null; then
  exit 0
fi

# Query proxy for token usage since last commit (2s timeout, silent fail)
# Use --git-common-dir to resolve to main repo root (matches dashboard storage)
REPO=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git/*$||') ||
REPO=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
LAST_TS=$(( $(git log -1 --format=%ct 2>/dev/null || echo 0) * 1000 ))
USAGE=$(curl -s --max-time 2 "http://localhost:${VDM_PORT}/api/token-usage?repo=${REPO}&since=${LAST_TS}" 2>/dev/null) || exit 0

# Build the trailer. The usage JSON goes in on stdin, not argv: a busy repo can
# produce more than the command line accepts, and that limit is much lower on
# Windows than on macOS.
printf '%s' "$USAGE" | "$VDM_NODE" "$VDM_HELPER" commit-trailer "$1" 2>/dev/null || true
HOOKEOF

  chmod +x "$hook_file" 2>/dev/null || true
}

_uninstall_git_hook() {
  local hooks_dir=""
  hooks_dir=$(git config --global core.hooksPath 2>/dev/null) || true

  if [[ -z "$hooks_dir" ]]; then
    hooks_dir="$HOME/.config/git/hooks"
  else
    hooks_dir="${hooks_dir/#\~/$HOME}"
  fi

  local hook_file="$hooks_dir/prepare-commit-msg"

  if [[ -f "$hook_file" ]] && grep -q "$_VDM_HOOKS_MARKER" "$hook_file" 2>/dev/null; then
    # Restore original if we moved one aside
    if [[ -f "${hook_file}.vdm-original" ]]; then
      mv "${hook_file}.vdm-original" "$hook_file" 2>/dev/null || true
    else
      rm -f "$hook_file" 2>/dev/null || true
    fi
  fi

  # If we set core.hooksPath and no other hooks remain, unset it
  if [[ -f "$hooks_dir/$_VDM_HOOKS_PATH_MARKER" ]]; then
    local remaining
    remaining=$(find "$hooks_dir" -maxdepth 1 -type f ! -name "$_VDM_HOOKS_PATH_MARKER" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$remaining" -eq 0 ]]; then
      git config --global --unset core.hooksPath 2>/dev/null || true
      rm -rf "$hooks_dir" 2>/dev/null || true
    else
      rm -f "$hooks_dir/$_VDM_HOOKS_PATH_MARKER" 2>/dev/null || true
    fi
  fi
}
