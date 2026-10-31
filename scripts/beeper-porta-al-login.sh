#!/bin/zsh
# Una tantum (25/10): Beeper zombie teneva la 23373 e il gateway è stato spostato sulla 23374.
# Dopo il riavvio Beeper torna sulla sua porta: riallinea il gateway, poi si toglie da solo.
CFG=~/.claude/jarvis/mcp-servers/gateway/gateway-config.json
for i in {1..60}; do
  port=$(lsof -nP -iTCP -sTCP:LISTEN -a -c Beeper 2>/dev/null | awk 'NR>1{split($9,a,":");print a[2]}' | sort -n | head -1)
  [ -n "$port" ] && break; sleep 10
done
[ -z "$port" ] && exit 0   # Beeper non partito: riprova al prossimo login
sed -i '' -E "s#127\.0\.0\.1:2337[0-9]/v0/mcp#127.0.0.1:${port}/v0/mcp#" "$CFG"
echo "$(date '+%F %T') gateway beeper -> $port" >> ~/.claude/jarvis/logs/beeper-porta.log
launchctl bootout gui/$(id -u)/com.jarvis.beeper-porta; trash ~/Library/LaunchAgents/com.jarvis.beeper-porta.plist
