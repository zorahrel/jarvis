---
name: trend-research
description: |
  Research viral short-form trends on Instagram Reels/TikTok: trending content, competitor accounts, top videos per hashtag/topic, niche benchmarks. Returns structured reports (views, likes, hooks). NOT for generic web search — use exa/firecrawl.
allowed-tools: Bash(~/.claude/skills/trend-research/scripts/*), Bash(jq *), Bash(curl *), Read, Write
---

# Trend Research — IG Reels + TikTok

Discovers top short-form video content for a hashtag, topic, or profile. Output: markdown report saved under `/tmp/trend-<slug>.md` with captions, metrics, and hook patterns.

## Prerequisites

Apify API token. Free plan = $5/month recurring credit (enough for ~1000 IG posts or ~5000 TikToks per month).

Check setup:

```bash
~/.claude/skills/trend-research/scripts/check.sh
```

If missing, see [rules/install.md](rules/install.md).

## Commands

### IG hashtag / profile
```bash
~/.claude/skills/trend-research/scripts/ig.sh hashtag "devtok" --limit 30
~/.claude/skills/trend-research/scripts/ig.sh profile "marc.kaz" --limit 30
```

### TikTok hashtag / profile
```bash
~/.claude/skills/trend-research/scripts/tt.sh hashtag "coding" --limit 50
~/.claude/skills/trend-research/scripts/tt.sh profile "username" --limit 30
```

### Report from results
```bash
~/.claude/skills/trend-research/scripts/report.sh /tmp/raw-ig-devtok.json > /tmp/trend-devtok.md
```

## Workflow

1. Clarify target (hashtag? profile? both platforms?) and niche size (100 vs 1000 samples).
2. Run the right scraper script. Raw JSON lands in `/tmp/raw-<platform>-<slug>.json`.
3. Pipe through `report.sh` to get a human-readable summary ranked by engagement.
4. Summarize top 5-10 hooks + common visual patterns for the user.

## Cost awareness

- Each IG Reels hashtag run with 30 items ≈ $0.02 credit
- Each TikTok hashtag run with 50 items ≈ $0.01 credit (clockworks/free-tiktok-scraper)
- Monitor balance: `~/.claude/skills/trend-research/scripts/check.sh`

Credit exhausted? See [rules/fallback.md](rules/fallback.md) for open-source fallbacks.

## Security

- API token read at runtime from `~/.openclaw/openclaw.json` via `jq`, never echoed.
- Scripts refuse to run if token is missing (no hardcoded fallback).
- Raw output in `/tmp/` only — no persistence in repo.
