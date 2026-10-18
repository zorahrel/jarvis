#!/bin/bash
# Stop hook: report the wall-clock time the turn finished.
# Prints a systemMessage (shown in the CLI) and stores the timestamp for the statusline.
[[ "$JARVIS_SPAWN" == "1" ]] && exit 0

NOW="$(date +%H:%M:%S)"
printf '%s\n' "$NOW" > "$HOME/.claude/last-finish.txt" 2>/dev/null

printf '{"systemMessage":"\\u23f1 finito alle %s","suppressOutput":true}\n' "$NOW"
exit 0
