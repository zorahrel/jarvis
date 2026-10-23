# Proposed change to `~/.claude/settings.json` (not applied)

Add two hooks; the shared script prints one line only when the current project is over its budget
(`~/.config/claude-usage-hub/budgets.json`), reading a cache (~70 ms, never scans logs).

```json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "$HOME/.agents/hooks/usage-budget", "timeout": 2 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "$HOME/.agents/hooks/usage-budget", "timeout": 2 }] }]
}
```

If `hooks` already has these events, append the object to the existing array instead of replacing it.
The same session is warned once, then again after 30 minutes at most.

## Other harnesses
- jcode: only `[hooks] pre_tool_timeout_ms` (pre-tool), no session-start or prompt event. Not hooked.
- Muse Code: plugin hooks document `PreToolUse` only. Not hooked (a line per tool call would be noise).
- Codex: not checked.
