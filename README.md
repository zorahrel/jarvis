# Jarvis

Personal AI setup of one person, in the open: the agents, hooks, commands, workflows, scripts and MCP servers that run Claude Code, Codex, jcode and an [OpenClaw](https://github.com/openclaw/openclaw) assistant (WhatsApp, Discord) on one Mac.

Everything personal (identity, memory, contacts, client notes, rules about real people) lives in a **private git submodule** at `private/`, encrypted with git-crypt. This repo holds only what can be read by anyone.

## The pattern: one public repo, one private submodule

```
jarvis/                 public  (this repo)
├── claude/             public half of ~/.claude: agents, commands, hooks, setup scripts, workflows
├── openclaw/           public half of the OpenClaw workspace: workflows, tests, gateway scripts
├── scripts/  mcp-servers/  memory-recall/  distilled/  docs/
├── sync-public.sh      live config -> claude/ and openclaw/  (allow-list: only unencrypted files)
└── private/            submodule -> your PRIVATE repo, git-crypt encrypted
    ├── claude/         CLAUDE.md, memories, own skills, everything ai-config encrypted
    ├── openclaw/       persona, directives, the assistant's memory
    └── sync.sh         live config -> private copy, daily via launchd
```

The live folders (`~/.claude`, `~/.openclaw`) stay where the tools read them. Two scripts copy them into the two halves: nothing is symlinked, because git stores a directory symlink as a link and a backup made of links clones empty.

**What decides public vs private** is the source's own `.gitattributes`: a file that git-crypt encrypts in the source is private, everything else may be public. A pre-push hook ([push-guard](claude/setup/bin)) still blocks names, phone numbers, chat IDs, emails and tokens before anything reaches GitHub.

**Secrets never go in either repo**, not even encrypted: API keys and passwords stay in the macOS Keychain and are read at runtime (`security find-generic-password -s <service> -a <account> -w`). The git-crypt keys themselves are kept in a password manager.

## Use it for your own setup

1. Fork this repo and remove what you don't need.
2. Create an empty **private** repo, run `git-crypt init` in it, and add a `.gitattributes` that encrypts everything except `.gitattributes`, `.gitignore`, `README.md` and `sync.sh`.
3. Point the submodule at it: `git submodule set-url private <your-private-repo>`.
4. Adapt `private/sync.sh` and `sync-public.sh` to your folders; schedule the private one (launchd or cron).
5. Store the git-crypt key in your password manager: without it the private repo is unreadable, also for you.

Cloning without access to the private repo works: `private/` simply stays empty.

## History

Until October 2026 this repo was **Jarvis Claude Code**, a multi-channel router that brought the Claude Code CLI to Telegram, WhatsApp and Discord. Its channels moved to OpenClaw; the router code is in the git history (tag `router-final`).

MIT License.
