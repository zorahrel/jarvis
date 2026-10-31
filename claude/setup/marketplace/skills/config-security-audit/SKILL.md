---
name: config-security-audit
description: Audit an agent-harness configuration directory (.claude/, ~/.claude.json, MCP servers, hooks, settings, CLAUDE.md) for security risks — hardcoded secrets, prompt-injection surface, overly permissive allow-lists, unpinned npx supply-chain, dangerous bypass flags, and hook command-injection. Standalone, no external dependencies.
origin: standard (inspired by ECC AgentShield, reimplemented dependency-free)
---

# Config Security Audit

Static security audit of a Claude Code / agentic-harness configuration. Pure
`bash` + `grep` + `python3` — no npm package, no network, no API key. Portable
across any machine that has a `.claude` setup.

## When to Activate

- User says "security audit", "scan my config", "audit .claude", "check my MCP servers"
- After editing `settings.json`, `CLAUDE.md`, `.mcp.json`, or `~/.claude.json`
- Before committing config changes or sharing a repo with `.claude/` committed
- Periodic hygiene check on a setup with many MCP servers / hooks

## What It Checks

| Target | Risk class |
|--------|-----------|
| `~/.claude.json` + `.mcp.json` | hardcoded secrets in MCP env, unpinned `npx @latest` supply-chain, untrusted remote MCP urls |
| `settings.json` / `settings.local.json` | `bypassPermissions` / dangerous-skip flags, wildcard `Bash(*)` allow-lists, missing deny-list, broad `WebFetch`/`Write` grants |
| `hooks` (settings + scripts) | command injection via unquoted interpolation, secret exfiltration (`curl`/`nc` to remote), silent error suppression |
| `CLAUDE.md` / `AGENTS.md` | hardcoded secrets, auto-run / "always run X" injection instructions |
| router `config.yaml` (if present) | secrets in plaintext, channels exposed without auth |

## Usage

Run the bundled scanner. Default target is the user-global config; pass a path to
scan a project.

`CLAUDE_PLUGIN_ROOT` is set for you when the skill is loaded as a plugin. If you
run it from the agents hub instead, `cd` into the skill directory first — the
scanner reads no state from its own path, so either way works.

```bash
# As a plugin: scan user-global config (~/.claude + ~/.claude.json)
bash "$CLAUDE_PLUGIN_ROOT/scan.sh"

# From the agents hub
cd ~/.agents/skills/config-security-audit && bash scan.sh

# Scan a specific project's .claude dir
bash scan.sh /path/to/project/.claude

# Only show medium+ findings
bash scan.sh --min-severity medium
```

The script exits `0` if no HIGH findings, `1` if any HIGH finding exists — usable
in a pre-commit hook or CI gate.

## How To Report

After running, summarize findings grouped by severity (HIGH → MEDIUM → LOW). For
each HIGH: quote the file + line, explain the risk in one sentence, give the fix.
Never auto-edit config to "fix" a finding without explicit confirmation — secrets
and permission changes are the user's call.

## Heuristics, Not Proof

This is static pattern-matching: it flags *candidates*, not confirmed exploits.
A flagged secret may be a placeholder; a wildcard allow-list may be intentional.
Treat output as a triage list, verify before acting.
