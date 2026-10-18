#!/bin/bash
# Hook: notify Jarvis router of CLI session start/stop
# Called by Claude Code hooks (UserPromptSubmit / Stop)

ACTION="${1:-start}"
SESSION_ID="${CLAUDE_SESSION_ID:-cli-$$}"
WORKSPACE="$(pwd)"
ROUTER="http://localhost:3340"

if [ "$ACTION" = "start" ]; then
  curl -s -X POST "$ROUTER/api/session-start" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"$SESSION_ID\",\"workspace\":\"$WORKSPACE\"}" \
    --connect-timeout 2 > /dev/null 2>&1 &
elif [ "$ACTION" = "stop" ]; then
  curl -s -X POST "$ROUTER/api/session-stop" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"$SESSION_ID\"}" \
    --connect-timeout 2 > /dev/null 2>&1 &
fi
