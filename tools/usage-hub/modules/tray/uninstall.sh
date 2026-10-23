#!/bin/sh
# Stop the tray + server and remove their LaunchAgents.
set -e
UID="$(id -u)"
for L in "io.github.$(id -un).usage-server" "io.github.$(id -un).claude-usage-tray"; do
    launchctl bootout "gui/$UID/$L" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$L.plist"
done
echo "tray + server removed (repo files untouched)"
