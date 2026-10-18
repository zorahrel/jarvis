#!/usr/bin/env bash
#
# Synthetic test channel — invokes the Jarvis agent with the EXACT same
# spawn args that the router uses for Telegram/WhatsApp/Discord messages.
#
# Usage:
#   bash invoke-jarvis.sh "your message here"
#   MODEL=claude-opus-4-6 bash invoke-jarvis.sh "your message"     # use Jarvis's real model
#
# Environment:
#   MODEL  — Claude model (default: claude-haiku-4-5-20251001 for speed/cost)
#   JSON   — if set, print full JSON result instead of trimmed text
#
# Why this exists: lets me test end-to-end without needing to send Telegram
# messages, while reproducing the spawn args from router/src/services/claude.ts
# exactly (bypassPermissions + user,project,local + all MCP servers + cwd).

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <prompt>" >&2
  exit 1
fi

PROMPT="$1"
MODEL="${MODEL:-claude-haiku-4-5-20251001}"
AGENT_CWD="$HOME/.claude/jarvis/agents/jarvis"

if [ ! -d "$AGENT_CWD" ]; then
  echo "Jarvis agent workspace missing: $AGENT_CWD" >&2
  exit 1
fi

# Build MCP config the same way the router does: inject all shared servers
# from ~/.claude.json when the agent has fullAccess (Jarvis does).
# We use a simplified version: empty MCP (test doesn't exercise MCP tools).
MCP='{"mcpServers":{}}'

# Mirror router spawn args from router/src/services/claude.ts::buildSpawnArgs
RESULT=$(cd "$AGENT_CWD" && echo "$PROMPT" | claude \
  --print \
  --permission-mode bypassPermissions \
  --model "$MODEL" \
  --setting-sources user,project,local \
  --exclude-dynamic-system-prompt-sections \
  --output-format json \
  --strict-mcp-config \
  --mcp-config "$MCP" \
  --effort high 2>&1)

if [ -n "${JSON:-}" ]; then
  echo "$RESULT"
else
  # Extract just the text answer + denials summary
  python3 - <<PY
import json, sys
r = json.loads('''$(echo "$RESULT" | tr '\n' ' ' | sed "s/'/\\\\'/g")''')
print(r.get("result", "(no result)"))
denials = r.get("permission_denials", [])
if denials:
    print()
    print(f"[!] {len(denials)} permission denial(s):")
    for d in denials:
        print(f"  - {d.get('tool_name','?')} on {d.get('tool_input',{}).get('file_path', d.get('tool_input',{}).get('command',''))[:80]}")
PY
fi
