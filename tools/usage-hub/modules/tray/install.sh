#!/bin/sh
# Build + install the tray and its server as user LaunchAgents.
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "node is required (https://nodejs.org)"; exit 1; }
command -v swiftc >/dev/null || { echo "Xcode CLT are required (xcode-select --install)"; exit 1; }
swiftc -O ClaudeUsage.swift ProviderIcon.swift MacStats.swift ProcessWindow.swift main.swift -o ClaudeUsage
NODE="$(command -v node)"
AGENTS="$HOME/Library/LaunchAgents"
TRAY_LABEL="io.github.$(id -un).claude-usage-tray"
SRV_LABEL="io.github.$(id -un).usage-server"
mkdir -p "$AGENTS"
cat > "$AGENTS/$TRAY_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$TRAY_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PWD/ClaudeUsage</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-usage-tray.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-usage-tray.err</string>
</dict>
</plist>
EOF
cat > "$AGENTS/$SRV_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SRV_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$PWD/server/server.mjs</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/usage-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/usage-server.err</string>
</dict>
</plist>
EOF
UID="$(id -u)"
for L in "$SRV_LABEL" "$TRAY_LABEL"; do
    launchctl bootout "gui/$UID/$L" 2>/dev/null || true
    launchctl bootstrap "gui/$UID" "$AGENTS/$L.plist"
done
echo "tray + server installed and started"
