---
name: restart
description: Update Claude Code to the latest version and resume the current session without losing context. Use when the user wants to restart, refresh, update Claude Code, reload the binary, or pick up a new CLI release. Handles the full exit + update + resume cycle automatically via a zsh precmd hook.
---

# Restart Skill

Fully automatic restart. Works by writing a flag file and killing the current
claude process; a zsh precmd hook (installed once in `~/.zshrc`) picks up the
flag on the next shell prompt, runs `claude update` if requested, and
`exec claude -c` — reusing the same TTY so the terminal tab stays open.

## First run — check the hook is installed

Run:

```bash
grep -q "jarvis-restart-hook" ~/.zshrc && echo INSTALLED || echo MISSING
```

If MISSING, stop and ask the user to append these 4 lines to `~/.zshrc`:

```bash
# BEGIN jarvis-restart-hook
[[ -f "$HOME/jarvis/skills-marketplace/skills/restart/hook.zsh" ]] \
  && source "$HOME/jarvis/skills-marketplace/skills/restart/hook.zsh"
# END jarvis-restart-hook
```

Then `source ~/.zshrc` in every existing terminal tab where claude might run.
The hook is idempotent and only fires when the flag file exists.

## Main flow

1. **Determine action** — default `restart`. If the user said "update",
   "aggiorna", "nuova versione", "upgrade", use `update`.

2. **Write the flag file** with action + cwd:

   ```bash
   printf '%s|%s' "<action>" "$PWD" > ~/.jarvis-restart
   ```

   The cwd part lets the new claude session start where the old one left off,
   in case Ctrl+D lands the shell somewhere else.

3. **Tell the user what will happen, then kill claude**:

   ```bash
   ( sleep 0.4 && kill "$PPID" ) & disown
   ```

   The short sleep lets this bash subshell exit cleanly first. `$PPID` is the
   running claude process. SIGTERM triggers graceful shutdown; the session
   JSONL is flushed to disk.

4. **Print a short goodbye** (Italian, ASCII only):

   ```
   Restart in corso. Al prompt shell rientro automaticamente con `claude -c`.
   ```

5. **Do not call further tools after step 3** — claude will die any moment.

## Alternative flow — skills/plugins only

If the user only wants to pick up new skills/MCP without killing the process,
tell them to type `/reload-plugins` themselves. It is a native Claude Code
command; this skill cannot invoke slash commands.

Known bug (issue #35641): `/reload-plugins` sometimes misses skills installed
from a marketplace during the session. If it fails, fall back to the main flow.

## Rules

- Italian replies by default. ASCII only. Terse.
- Never hot-reload the binary in-place — impossible.
- Never invoke `/restart` or any slash command from inside a skill.
- If `claude update` is unavailable (Homebrew etc.), the hook prints a warning
  and still re-execs the current version.
- If the user is not running under zsh, the hook will not fire — fall back to
  instructing `Ctrl+D` + `claude -c` manually.

## Files

- `hook.zsh` — the precmd hook. Sourced by `~/.zshrc` once.
- `~/.jarvis-restart` — ephemeral flag, consumed + deleted on next prompt.

## References

- `claude --continue` / `-c` — resume most recent session in current cwd.
- `claude --resume` / `-r` — open picker to choose a past session.
- Session transcripts: `~/.claude/projects/<cwd-slug>/*.jsonl`.
