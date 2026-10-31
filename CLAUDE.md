# Jarvis

Repo pubblico zorahrel/jarvis: script, strumenti e l'hub :3360 (`tools/usage-hub`). Canali e cron di Jarvis stanno in OpenClaw; il router :3340 è ritirato dal 18/10 (codice nel tag `router-final`).

## Ports
3335/3336: Switchboard (proxy account Claude) | 3342: docs-index (si accende alla prima richiesta) | 3360: hub

## Rules
- Never hardcode secrets: Keychain or env vars
- Don't use Docker
- Don't add npm dependencies without good reason
- Don't modify agents' CLAUDE.md without understanding the scoping
- `tools/usage-hub` never goes to the public repo (origin is public). Never `git push` main by hand: publish with `scripts/publish-public.sh` (pushes ONE commit on top of the remote: main's final tree minus the paths in the script's `EXCLUDE` list; `--status` shows what would change). Test: `scripts/publish-public-test.sh`. `git status` reporting main as diverged from origin/main is expected, and a `pre-push` hook rejects any raw push that contains the folder. Backup of the hub is in `private/` (`private/sync.sh`, encrypted).
- Identity: two layers only — `~/.claude/CLAUDE.md` (user-global) + `<workspace>/CLAUDE.md` (agent). NEVER add a third layer via `--append-system-prompt`.
