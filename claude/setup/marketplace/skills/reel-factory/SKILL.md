---
name: reel-factory
description: |
  Produce a vertical 9:16 promo reel (MP4) for a GitHub repo: scrolling README + AI voiceover, devtok style. Triggers: "reel/TikTok/short per repo", "voiceover README", "video promo repo". NOT for generic video editing or long-form.
allowed-tools: Bash(~/.claude/skills/reel-factory/scripts/*), Bash(ffmpeg *), Bash(ffprobe *), Bash(curl *), Bash(jq *), Bash(npx *), Read, Write
---

# Reel Factory — GitHub repo promo video

Turns a GitHub repo URL into a 9:16 MP4 suitable for Instagram Reels / TikTok / YouTube Shorts.

Pipeline:
1. Fetch repo metadata + README
2. You (the model) write a 30-60s script in the user's preferred language, marc.kaz-style hook → features → CTA
3. ElevenLabs TTS generates voiceover MP3
4. WebKit (Playwright) captures full-page screenshot of GitHub README (1080px wide) — Chrome is banned on this Mac
5. ffmpeg creates a scrolling video timed to the audio duration
6. Output: `/tmp/reel-<slug>.mp4`

## Prerequisites

ElevenLabs API key at `~/.openclaw/openclaw.json` (key path: `.. | .elevenlabs.apiKey`). Default voice/language also read from that config.

Check setup:
```bash
~/.claude/skills/reel-factory/scripts/check.sh
```

## Commands

```bash
# One-shot end-to-end (most common)
~/.claude/skills/reel-factory/scripts/build.sh https://github.com/USER/REPO "Path to script.txt"

# Individual stages (for debug / re-run)
~/.claude/skills/reel-factory/scripts/fetch.sh https://github.com/USER/REPO      # saves readme + meta
~/.claude/skills/reel-factory/scripts/tts.sh /tmp/script.txt /tmp/voice.mp3
~/.claude/skills/reel-factory/scripts/screenshot.sh https://github.com/USER/REPO /tmp/readme.png
~/.claude/skills/reel-factory/scripts/assemble.sh /tmp/readme.png /tmp/voice.mp3 /tmp/reel.mp4
```

## Writing the script (agent guidance)

Target length: 130-170 words = ~45-55s at normal pace.

Proven hook format (marc.kaz, 2.5M plays across 12 reels):
1. `🚨 ALL-CAPS CLAIM — PUNCHY NUMBER/ADJECTIVE` (5-7 words)
2. One sentence explaining what it does
3. `Ships with:` bullet list — 4-6 concrete features (tech specs, not marketing fluff)
4. Closing: license + call-to-action

Language: use the user's language. ElevenLabs config declares `languageCode` — match it.

Do NOT add emoji inside the bullet items, only the opening 🚨. TTS reads emoji as silence which is fine for the leading siren, noisy elsewhere.

## Security

API key read on-demand via jq, never echoed to logs. All intermediate files in `/tmp/` only.
