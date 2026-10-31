#!/usr/bin/env bash
# config-security-audit — dependency-free static audit of an agent-harness config.
# Deps: bash, grep, python3, find. No npm, no network.
set -uo pipefail

MIN_SEV="low"
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --min-severity) MIN_SEV="${2:-low}"; shift 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

CLAUDE_DIR="${TARGET:-$HOME/.claude}"
CLAUDE_JSON="$HOME/.claude.json"

HIGH=0; MED=0; LOW=0
sev_rank() { case "$1" in high) echo 3;; medium) echo 2;; *) echo 1;; esac; }
MIN_RANK=$(sev_rank "$MIN_SEV")

finding() { # sev file msg
  local r; r=$(sev_rank "$1")
  [ "$r" -lt "$MIN_RANK" ] && return
  case "$1" in
    high)   HIGH=$((HIGH+1)); printf '\033[31m[HIGH]\033[0m   %s\n          %s\n' "$2" "$3" ;;
    medium) MED=$((MED+1));   printf '\033[33m[MEDIUM]\033[0m %s\n          %s\n' "$2" "$3" ;;
    *)      LOW=$((LOW+1));   printf '\033[36m[LOW]\033[0m    %s\n          %s\n' "$2" "$3" ;;
  esac
}

# Secret patterns: provider keys (alnum bodies — no long hyphen runs, so file
# paths like sk-task-enrichment-... don't match) + PEM private keys.
SECRET_RE='sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{15,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

scan_secrets() { # file  — note: loop runs in main shell via process substitution
  local f="$1"; [ -f "$f" ] || return
  while IFS= read -r ln; do
    finding high "$f:${ln%%:*}" "Possible hardcoded secret: $(echo "${ln#*:}" | sed 's/^ *//' | cut -c1-100)"
  done < <(grep -nE "$SECRET_RE" "$f" 2>/dev/null)
}

echo "=== config-security-audit ==="
echo "target: $CLAUDE_DIR    (min-severity: $MIN_SEV)"
echo

# ---- 1. MCP servers (~/.claude.json + any .mcp.json) ----------------------
MCP_FILES=("$CLAUDE_JSON")
while IFS= read -r f; do MCP_FILES+=("$f"); done < <(find "$CLAUDE_DIR" -maxdepth 3 \( -name '.mcp.json' -o -name 'mcp.json' \) 2>/dev/null)
for f in "${MCP_FILES[@]}"; do
  [ -f "$f" ] || continue
  scan_secrets "$f"
  # unpinned npx supply-chain — one finding per "command": "npx" line
  while IFS= read -r ln; do
    finding medium "$f:${ln%%:*}" "npx MCP server — ensure its package arg is version-pinned (not @latest): ${ln#*:}"
  done < <(grep -nE '"command": *"npx"' "$f" 2>/dev/null)
done

# ---- 2. settings.json / settings.local.json -------------------------------
for f in "$CLAUDE_DIR"/settings.json "$CLAUDE_DIR"/settings.local.json; do
  [ -f "$f" ] || continue
  scan_secrets "$f"
  while IFS= read -r ln; do
    finding medium "$f:${ln%%:*}" "Permission bypass flag enabled — confirm intentional: $(echo "${ln#*:}" | sed 's/^ *//')"
  done < <(grep -nEi 'bypassPermissions|dangerouslySkip|skipDangerousMode|skipAutoPermission' "$f" 2>/dev/null)
  while IFS= read -r ln; do
    finding high "$f:${ln%%:*}" "Wildcard allow-list grants broad tool access: $(echo "${ln#*:}" | sed 's/^ *//')"
  done < <(grep -nE '"Bash\(\*\)"|"Bash\(:\*\)"|"\*"|"Write\(\*\)"|"WebFetch\(\*\)"' "$f" 2>/dev/null)
  if grep -q '"allow"' "$f" 2>/dev/null && ! grep -q '"deny"' "$f" 2>/dev/null; then
    finding low "$f" "Permissions has allow-list but no deny-list — consider denying secret/file reads (.env, *.pem)."
  fi
done

# ---- 3. hooks (standalone hook scripts) -----------------------------------
while IFS= read -r f; do
  [ -f "$f" ] || continue
  scan_secrets "$f"
  while IFS= read -r ln; do
    finding medium "$f:${ln%%:*}" "Hook makes outbound network call (verify destination, not exfil): $(echo "${ln#*:}" | sed 's/^ *//' | cut -c1-90)"
  done < <(grep -nE '\b(curl|wget|nc|ncat)\b.*(https?://|[0-9]{1,3}(\.[0-9]{1,3}){3})' "$f" 2>/dev/null | grep -vE 'localhost|127\.0\.0\.1')
  while IFS= read -r ln; do
    finding high "$f:${ln%%:*}" "Hook interpolates untrusted input into a shell command (injection): $(echo "${ln#*:}" | sed 's/^ *//' | cut -c1-90)"
  done < <(grep -nE 'eval .*\$(TOOL|PROMPT|INPUT|ARG)|`[^`]*\$(TOOL|PROMPT|INPUT)' "$f" 2>/dev/null)
done < <(find "$CLAUDE_DIR" -maxdepth 4 -type f \( -name '*.sh' -path '*hook*' -o -path '*/hooks/*' \) ! -name '*.sample' 2>/dev/null)

# ---- 4. CLAUDE.md / AGENTS.md ---------------------------------------------
while IFS= read -r f; do
  [ -f "$f" ] || continue
  scan_secrets "$f"
  while IFS= read -r ln; do
    finding low "$f:${ln%%:*}" "Auto-run instruction in memory file — prompt-injection amplifier if shared: $(echo "${ln#*:}" | sed 's/^ *//' | cut -c1-80)"
  done < <(grep -nEi 'automatically (run|execute)|without (asking|confirmation).*(run|execute)|on every (prompt|message).*run' "$f" 2>/dev/null)
done < <(find "$CLAUDE_DIR" "$(dirname "$CLAUDE_DIR")" -maxdepth 2 \( -iname 'CLAUDE.md' -o -iname 'AGENTS.md' \) 2>/dev/null | sort -u)

# ---- 5. router config.yaml (if present) -----------------------------------
while IFS= read -r f; do
  scan_secrets "$f"
done < <(find "$CLAUDE_DIR" -maxdepth 3 -name 'config.yaml' -path '*router*' 2>/dev/null)

# ---- summary --------------------------------------------------------------
echo
echo "=== summary: $HIGH high, $MED medium, $LOW low ==="
[ "$HIGH" -gt 0 ] && exit 1 || exit 0
