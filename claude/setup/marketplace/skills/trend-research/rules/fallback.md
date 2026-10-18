# Fallbacks — no Apify credit

## TikTok (no login needed)

`drawrowfly/tiktok-scraper` (5k⭐) — run via npx, no install:

```bash
npx tiktok-scraper hashtag coding -n 30 --filetype json
npx tiktok-scraper user someuser -n 30 --filetype json
```

Last push 2023. If Web API layout changed it may break.

## Instagram single URL (no login)

`ahmedrangel/instagram-media-scraper` (171⭐) — GraphQL method, no cookie needed for single posts. Copy the snippet from the README and run as a one-off Node script. Gives caption, media, timestamp, owner. No hashtag discovery.

## Profile browse with cookie (scale)

`instaloader` (10k⭐, Python) for full profile crawls — requires cookie import. Respects rate limits.

```bash
pip install instaloader
instaloader --login=YOUR_USER profile TARGET_USER
```

## Manual discovery

Open the target hashtag/profile in Chrome via `mcp__claude-in-chrome__navigate`, scroll, read visible posts. Slow but zero-cost and gives real metrics. Good for quick 5-10 reel sampling.
