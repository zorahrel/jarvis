#!/bin/bash
# Persistent profile per Claude session, fallback to --isolated if locked.
PROFILE="$HOME/.cache/cdp-mcp/profile-default"
LOCK="$PROFILE/SingletonLock"
mkdir -p "$PROFILE"
if [ -e "$LOCK" ] && pgrep -f "user-data-dir=$PROFILE" >/dev/null 2>&1; then
  exec npx -y chrome-devtools-mcp@latest --isolated
else
  exec npx -y chrome-devtools-mcp@latest --userDataDir "$PROFILE"
fi
