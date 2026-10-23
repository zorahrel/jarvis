# claude-usage-hub

**Which project is eating your weekly Claude quota, and a nudge before it runs out.**

![dashboard](docs/dashboard.png)

Claude gives you one weekly percentage per account. This reads the logs Claude Code already writes
(`~/.claude/projects`), splits that percentage across projects, and fires alerts you configure.
Local, zero dependencies, nothing leaves your machine except the alert you ask for.

## How the number is made
`project % = project weighted tokens / all weighted tokens this week x account weekly %`
Weights (price ratios): input 1, output 5, cache write 1.25, cache read 0.1. It is an estimate, the real
limiter is not published. Why not just use ccusage or codeburn: see [DESIGN.md](DESIGN.md).

## Install

Needs Node 20 or newer.

**macOS / Linux**
```sh
git clone <this repo> && cd claude-usage-hub
cp config.example.json config.json
node bin/usage-hub.mjs serve          # dashboard on http://127.0.0.1:3350
sh install/install-mac.sh             # optional: launchd job for the alert check every 10 min
```

**Windows (PowerShell)**
```powershell
git clone <this repo>; cd claude-usage-hub
Copy-Item config.example.json config.json
node bin\usage-hub.mjs serve
.\install\install-windows.ps1         # optional: scheduled task for the alert check
```

Try it without any data: `node bin/usage-hub.mjs serve --demo` (port 3351).

## Where the weekly percentage comes from
`quotaSource.type = "tray"` reads the active Claude account from a
claude-usage-tray `/api/overview` (fed by the
VDM multi-account proxy). No tray? Use
`{ "type": "manual", "weekPct": 40, "weekResetsAt": <epoch ms> }`.

## CLI
```
usage-hub projects            # table of projects, % of the week
usage-hub check [--dry-run]   # evaluate alert rules, notify on new ones
usage-hub serve [--demo]      # dashboard + /api/projects + /api/alerts
usage-hub allow <provider> [--hours 12] [--class X] --by NAME --reason TEXT   # timed override of the pacing brake only (never an exhausted quota); `allow --list`, `allow --revoke <provider>`
```

## Alerts
Rules live in `config.json` (see `config.example.json`): per project or per account (`7d`, `5h`).
Each rule fires **once per weekly window** (5h rules once per 5h window), then stays quiet until the reset.
On fire, the event JSON goes to the command's stdin (`USAGE_HUB_MESSAGE` is also in the env) and/or is
POSTed to `webhook`. Default command prints the message to stdout, so a cron that announces stdout
(for an agent, a chat, an email) is enough:

```sh
*/10 * * * * cd /path/to/claude-usage-hub && node bin/usage-hub.mjs check
```

Event: `{ "id", "subject", "value", "threshold", "week", "message" }`.

## Privacy
Account labels are masked in the API and dashboard (`"showAccount": true` to show them). Project names
come from your working directories; group them with `groups` if you want friendlier names.

## Tests
`npm test` (Node built-in runner, weights, share maths, once-per-week alert, command and webhook, Muse provider, session hook).

## License
MIT

## Muse Code
`muse` has no readable limit, so the hub counts requests and tokens per project from
`~/.local/share/muse/sessions` for the same weekly window (`projects` CLI, `muse` key of `/api/projects`).
Reference model: `muse-wonder-1.0`; `wonderRequests` excludes the `full` variant.

## Session warning and shared budgets
Budgets live in one file, `~/.config/claude-usage-hub/budgets.json` (`label`, `budgetPct`, `match`, `hint`
per project); the hub turns them into groups and alert rules. `check` and `refresh` write a cache that
`bin/usage-hub-hook.mjs` reads (about 70 ms): as a SessionStart / UserPromptSubmit hook it prints one line
only when the current project is over budget. See `PROPOSTA-settings.md`.
```sh
0 * * * * cd /path/to/claude-usage-hub && node bin/usage-hub.mjs check   # prints only when a threshold fires, once per week
```
