#!/bin/bash
# PreToolUse(Bash) — blocks git commit / gh pr create containing a Co-Authored-By
# or "Generated with Claude Code" trailer. Enforces the CLAUDE.md rule at the
# harness level instead of relying on the model remembering not to add it.
cmd=$(jq -r '.tool_input.command // empty')

if echo "$cmd" | grep -qEi '(git([[:space:]]+-C[[:space:]]+[^ ]+)?[[:space:]]+commit|gh[[:space:]]+pr[[:space:]]+create)' \
   && echo "$cmd" | grep -qE 'Co-Authored-By|Generated with Claude Code'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Trailer Co-Authored-By / \"Generated with Claude Code\" vietato nei commit/PR (regola globale CLAUDE.md)."}}'
else
  echo '{}'
fi
