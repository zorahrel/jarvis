# Jarvis Skills Marketplace

Local Claude Code plugin marketplace that hosts Jarvis's custom skills
**outside** the `~/.claude/` safety-check zone, so Jarvis agents running
from Telegram/WhatsApp/Discord can create and edit skills directly.

## Why this exists

Claude Code 2.1.110 hard-blocks any `Write` / `Edit` / `Bash` operation that
touches `~/.claude/**`, regardless of `--permission-mode bypassPermissions`,
`--dangerously-skip-permissions`, `PreToolUse` hooks, or `permissionPromptTool`.
This is an intentional guardrail: no agent should modify a user's Claude Code
config without a human at the CLI.

Custom skills normally live in `~/.claude/skills/`, which is inside the
protected zone. So from Telegram, Jarvis could never install a new skill.

This marketplace lives under `~/jarvis/skills-marketplace/` — outside the
protected zone. Jarvis agents can `Write` new skills here freely.

Claude Code loads these skills transparently via its native plugin marketplace
mechanism (registered once with `claude plugin marketplace add`). From the
user's perspective, skills work identically to `~/.claude/skills/` ones —
available in every session, invoked via `/skill-name`, listed by the dashboard.

## Structure

```
~/jarvis/skills-marketplace/
├── .claude-plugin/
│   └── marketplace.json      ← declares the "jarvis-custom-skills" plugin
├── README.md                  ← you are here
├── LOCAL.md                   ← migration plan for this machine only
├── UPSTREAM.md                ← plan for pushing the arch change to the repo
├── migrate-local.sh           ← runs the local migration
├── upstream/                  ← files + patches to copy into ~/.claude/jarvis/
│   ├── CHANGELOG.md
│   ├── scripts/migrate-to-marketplace.sh
│   └── skills-marketplace.template/
└── skills/
    ├── jarvis-config/         ← symlink → ~/.claude/jarvis/skills/jarvis-config (post-migration)
    ├── reel-factory/          ← real directory (post-migration)
    └── trend-research/        ← real directory (post-migration)
```

## Two-phase rollout

- **Phase 1 — Local.** Run `bash migrate-local.sh` on your machine. Moves
  existing skills, registers the marketplace. See `LOCAL.md` for details.
  Nothing is pushed anywhere; zero impact on other users.

- **Phase 2 — Upstream.** Only after Phase 1 works, apply the `upstream/`
  changes to the `zorahrel/jarvis-claudecode` repo (new `CHANGELOG.md`,
  updated `setup.sh`, `router/src/dashboard/api.ts`, docs, plus the shipped
  migration script for other users). See `UPSTREAM.md` for the push checklist.

## Adding a new skill

### From CLI (you, interactively)
```bash
mkdir -p ~/jarvis/skills-marketplace/skills/my-new-skill
cat > ~/jarvis/skills-marketplace/skills/my-new-skill/SKILL.md <<'EOF'
---
name: my-new-skill
description: Brief description of what the skill does.
---
# my-new-skill

...body...
EOF
```

Then register the skill in `.claude-plugin/marketplace.json` under the `skills`
array, and run:

```bash
claude plugin marketplace update jarvis-skills
```

### From Jarvis (Telegram/WhatsApp/Discord)
Ask Jarvis: *"Create a skill that does X"*. The agent writes the SKILL.md
directly. New skill is available in the next Claude Code session
(~30s after the router's inactivity timeout kicks in).

## Removing a skill

Delete the skill directory and remove its entry from `marketplace.json`, then:

```bash
claude plugin marketplace update jarvis-skills
```

## What's NOT here

- `agent-reach` and `firecrawl` — third-party skills from Anthropic's
  `~/.agents/skills/`, accessed via symlinks in `~/.claude/skills/`. Not ours
  to manage, so they stay where they are.
- System skills shipped with Claude Code plugins — loaded via their own
  marketplaces (see `claude plugin marketplace list`).
