---
name: chatgpt-image
description: Generate image via ChatGPT through CDP-attached Chrome. Self-contained — auto-launches its own Chrome with persistent profile. Returns saved file path on stdout. No OpenClaw dependency.
---

# chatgpt-image

Trigger: user asks "genera immagine X" / "image of Y" / `/chatgpt-image "prompt"`.

## Run

```bash
bun run ~/jarvis/skills-marketplace/skills/chatgpt-image/run.ts "<prompt>" [--out <path>] [--port <n>]
```

Defaults:
- `--out` → `/tmp/chatgpt-image-<ts>.png`
- `--port` → `19223` (own port, no conflict with chrome-devtools-mcp on default)

Stdout = saved path. Stderr = progress.

## Behavior

1. Skill checks port `19223` for live Chrome.
2. If down: `open -g -n -a "Google Chrome" --args --user-data-dir=~/.cache/cdp-mcp/skill-profile --remote-debugging-port=19223` on chatgpt.com — launched behind, never steals focus.
3. If first run (or session expired): exits with login-required message. User logs in once in opened Chrome window. Login persists in profile.
4. Subsequent calls: reuse running Chrome. Skip launch.
5. Every call leaves one watchdog: Chrome is closed (`Browser.close`) after `--idle-min` (default 15) minutes without a call; the watchdog exits with Chrome (closed port, or 3 checks in a row with no answer; one slow answer is retried) and leaves overlapping calls to the newest one's watchdog. Log: `~/.cache/cdp-mcp/skill-watchdog.log`. With `--cdp` the browser is someone else's and stays on.
6. Not headless on purpose: the UA says HeadlessChrome (chatgpt.com sits behind Cloudflare) and an expired login needs a real window.

Barra: `bun watchdog-test.ts` (fake CDP, ~10 s, exit 0 = green).

## Agent flow

```
1. Run skill with prompt
2. Capture stdout path
3. Move to user-requested location (e.g. `mv $PATH ~/Pictures/Japan/...`)
4. Confirm
```

## Failure modes

- `Chrome failed to start CDP` → check Chrome installed at `/Applications/Google Chrome.app`
- `ChatGPT not logged in` → user logs in to opened Chrome window, retry
- `TIMEOUT` → ChatGPT refused/rate-limited

## Cost

- ~6-8K tokens per call
- ~40-50s wall (12s nav + 25-40s DALL-E + 2s download)
- Skill Chrome separate from chrome-devtools-mcp Chrome → no collision
