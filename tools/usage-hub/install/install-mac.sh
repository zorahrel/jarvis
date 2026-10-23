#!/bin/sh
# Installa un job launchd che esegue "usage-hub check" ogni 10 minuti.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
PLIST="$HOME/Library/LaunchAgents/dev.usagehub.check.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.usagehub.check</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/bin/usage-hub.mjs</string><string>check</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>StandardOutPath</key><string>$DIR/check.log</string>
  <key>StandardErrorPath</key><string>$DIR/check.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed $PLIST"
