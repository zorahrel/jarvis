# Install — Apify token

## One-time setup

1. Sign up free at https://apify.com (no credit card, $5 platform credit recurring every month).
2. Go to https://console.apify.com/account/integrations → copy the **Personal API token**.
3. Add it to `~/.openclaw/openclaw.json` under any top-level key. Example:

```json
{
  "apify": {
    "apiToken": "apify_api_XXXXXXXXXXXX"
  }
}
```

Alternatively export `APIFY_TOKEN` in your shell — the skill checks env first.

4. Make scripts executable:

```bash
chmod +x ~/.claude/skills/trend-research/scripts/*.sh
```

5. Verify:

```bash
~/.claude/skills/trend-research/scripts/check.sh
```

Expected output: `✓ Authenticated as 'your-user' (plan: FREE)`.

## Actors used

- `apify~instagram-hashtag-scraper` — paid actor, ~$2/1000 items
- `apify~instagram-profile-scraper` — paid actor, ~$2/1000 items
- `clockworks~free-tiktok-scraper` — **free actor**, no per-item cost (rate limited)

## Credit budget

Free plan gives $5/month platform credit. Rough budget:

- ~2500 IG posts/month at standard scrape cost
- Unlimited TikTok scrapes on free actor (subject to fair-use rate limits)

Exhausted? See [fallback.md](fallback.md).
