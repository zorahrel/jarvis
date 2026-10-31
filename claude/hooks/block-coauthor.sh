#!/bin/bash
# PreToolUse(Bash) — blocks git commit / gh pr create containing a Co-Authored-By
# or "Generated with Claude Code" trailer. Enforces the CLAUDE.md rule at the
# harness level instead of relying on the model remembering not to add it.
# Si cerca il trailer vero (nome e <email>) e la riga vera (col link o col 🤖), non le parole:
# il 24/10 bloccava i compiti per delegate che contenevano la regola «no Co-Authored-By trailer»,
# e lasciava passare «🤖 Generated with [Claude Code](…)», che è la riga che Claude Code scrive davvero.
# Barra: block-coauthor-test.sh
cmd=$(jq -r '.tool_input.command // empty')

if echo "$cmd" | grep -qEi '(git([[:space:]]+-C[[:space:]]+[^ ]+)?[[:space:]]+commit|gh[[:space:]]+pr[[:space:]]+create)' \
   && echo "$cmd" | grep -qEi 'co-authored-by:[^<]*<[^>]*@[^>]*>|generated with \[claude code\]|🤖[[:space:]]*generated with'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Trailer Co-Authored-By / \"Generated with Claude Code\" vietato nei commit/PR (regola globale CLAUDE.md)."}}'
else
  echo '{}'
fi
