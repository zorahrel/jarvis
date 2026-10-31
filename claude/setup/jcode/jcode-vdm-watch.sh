#!/bin/bash
# jcode-vdm-watch.sh — notify when jcode traffic escapes the vdm proxy.
#
# Runs the gate over a short window and posts a macOS notification when it turns
# red. Silence means measured-green, not unmeasured: a gate that cannot read the
# log exits 2 and is reported as an error, never as a pass.
#
# Notifies at most once per NOTIFY_COOLDOWN_MIN so a long-running stray session
# does not turn into a stream of alerts.

set -uo pipefail

WINDOW_MIN="${JCODE_VDM_WATCH_WINDOW:-10}"
COOLDOWN_MIN="${JCODE_VDM_WATCH_COOLDOWN:-60}"
GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jcode-vdm-gate.sh"
STATE="$HOME/.jcode/logs/vdm-watch.last-alert"
LOG="$HOME/.jcode/logs/vdm-watch.log"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

out="$("$GATE" "$WINDOW_MIN" 2>&1)"
rc=$?

if [ "$rc" -eq 0 ]; then
    echo "$(stamp) green" >> "$LOG"
    exit 0
fi

if [ "$rc" -eq 2 ]; then
    echo "$(stamp) ERROR gate could not measure: $(printf '%s' "$out" | head -1)" >> "$LOG"
    exit 2
fi

summary=$(printf '%s\n' "$out" | /usr/bin/grep -a '^FAIL' | sed 's/^FAIL  //' | paste -sd '; ' -)
echo "$(stamp) RED $summary" >> "$LOG"

# Cooldown: skip the notification if we alerted recently, but keep logging.
if [ -f "$STATE" ]; then
    last=$(cat "$STATE" 2>/dev/null || echo 0)
    now=$(date +%s)
    if [ $(( (now - last) / 60 )) -lt "$COOLDOWN_MIN" ]; then
        exit 1
    fi
fi
date +%s > "$STATE"

/usr/bin/osascript -e "display notification \"${summary//\"/}\" with title \"jcode is bypassing vdm\"" 2>/dev/null
exit 1
