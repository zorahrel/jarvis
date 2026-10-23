# Design

## Question
Claude subscriptions give one weekly percentage per account and no breakdown. Which *project* ate it, and can something tell me (or my agent) before it is gone?

## State of the art (checked 2026-10-13, GitHub)

| Project | What it does | Verdict |
|---|---|---|
| [ccusage](https://github.com/ccusage/ccusage) (~19k stars, Rust) | Cost and tokens from the local JSONL logs, daily/monthly/session/5h-block reports. | Reuse the idea (read `~/.claude/projects`). No per-project quota share, no alerts. |
| [codeburn](https://github.com/getagentseal/codeburn) (~11k, MIT, TS) | Per project, model and task in API-equivalent dollars, 37 tools, live 5h/weekly quota panel, menu bar, guard with budget caps. | The closest thing. It already does per-project well in **dollars**. It does not attribute the **weekly percentage** of an account to a project, and has no webhook or command alert for an agent. Best path for upstream: propose a "share of weekly quota" column there. |
| [budgetclaw](https://github.com/RoninForge/budgetclaw) (~8, MIT, Go) | Per `{project, branch}` dollar caps, SIGTERM on breach, ntfy alerts. | Same JSONL source, dollar caps instead of quota share. Not reused. |
| [Pacer](https://github.com/EricAndrechek/Pacer) (MIT, Swift) | Native macOS app, rate-limit pacing, per-project breakdown. | macOS only, GUI only. |
| ccusage-projects, claude-code-usage-per-project, cc-token-meter | Small per-project reports on top of ccusage or the logs. | Dollar views, no quota share, no alert hook. |

## What is different here
1. **Unit is the weekly quota %**, the number that actually blocks you: `project % = project weighted tokens / all weighted tokens since last weekly reset x account weekly %`. Weights: input 1, output 5, cache write 1.25, cache read 0.1 (price ratios). It is an estimate: the real limiter is not published.
2. **Multi-account aware** through the tray/VDM overview: only the active account's percentage is used.
3. **Alerts that talk to an agent**: a rule fires once per weekly window and runs a shell command (event JSON on stdin) and/or POSTs a webhook. Default command prints to stdout.

## Reused vs rebuilt
- Reused: the data source everyone uses (Claude Code JSONL logs), the price-ratio idea, the tray `/api/overview` contract for the live percentages (the tray itself reads them from the VDM proxy).
- Not reused: ccusage/codeburn as a library (they price in dollars and do not expose a stable programmatic per-project API; adding a dependency for a 60-line scanner is not worth it). Zero dependencies, Node >= 20.
- Rebuilt, small: scanner, quota-share maths, alert engine, dashboard.

## VDM proxy attribution: not done, on purpose
VDM sees each request and the working directory sits in the system prompt, so it *could* attribute at the proxy. But the JSONL already records `cwd` and usage per response, including requests that never went through a proxy, and a proxy-side counter would need a patch on a live, forked daemon. Revisit if VDM grows a per-request log with cwd.

## Layout
`src/usage.mjs` scan and weigh · `src/quota.mjs` account percentage (tray URL or manual) · `src/projects.mjs` share maths · `src/alerts.mjs` rules, once-per-week state, notify · `src/server.mjs` + `public/index.html` dashboard · `bin/usage-hub.mjs` CLI (`serve`, `projects`, `check`, `--demo`).
