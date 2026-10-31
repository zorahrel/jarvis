---
name: gemini-image-edit
description: Reference-conditioned image EDITING (swap a logo/object on a photo while keeping everything else identical) via Gemini Nano Banana (gemini-2.5-flash-image) on the web UI. This is the right tool when ChatGPT only "analyzes" attachments instead of editing them. Needs a one-time Google login.
---

# gemini-image-edit

Batch reference-edit of photos: attach each scene + a reference image (e.g. the real brand
logo) and ask Gemini to change ONLY the targeted element, preserving composition, lighting,
perspective and everything else. Gemini Nano Banana is purpose-built for this (logo/object swap,
inpaint-style edits) — unlike ChatGPT consumer, which routes attachments to "Analyzing images".

## When to use vs. siblings

- **Generate a NEW image from text** → `chatgpt-image` (DALL·E via CDP, no reference). Reliable, no login fight.
- **Edit an EXISTING image with a reference** (logo swap, object replace, restyle a region) → **this skill**.
- ChatGPT consumer (web/automation) does NOT do reference-conditioned editing — confirmed. Don't waste runs on it.

## One-time login (required) — OPEN since 14/09/2026

Gemini gates ALL tools (upload, create image) behind a signed-in Google session. Anonymous = every
tool greyed out ("Sign in to try tools").

**Today there is no working session.** The old capture went through `jbrowser` (retired 14/09) and
`gemini.json` does not exist. Cookies captured from Chromium browsers do not carry over: with
`dia-Profile_1-google_com.json` the WebKit page shows "Sign in" (checked 14/09). Chrome/Chromium are
banned on this Mac, so the session has to be born in a non-Chromium browser — the pending plan is
real Safari driven via AppleScript (see `~/.claude/jarvis/memory/tools/browser.md`). Until then, for
reference edits without a browser use the Higgsfield MCP (Nano Banana models, paid credits).

## Run

```bash
node ~/jarvis/skills-marketplace/skills/gemini-image-edit/scripts/gemini-edit.mjs \
  --scenes <dir-or-file> \
  --ref <reference-image.png> \
  --out <output-dir> \
  --task "Replace the brand logo on the carton with the logo in the second image; keep all else identical." \
  [--state ~/.claude/jarvis/state/browser-states/gemini.json] \
  [--only id1,id2]
```

- `--scenes` — a directory of PNG/JPG scenes, or a single file. Each is edited independently.
- `--ref` — the reference image attached as the SECOND file (the exact logo/object to apply).
- `--out` — where edited PNGs are written (named after each scene).
- `--task` — the edit instruction. Be explicit: "change ONLY X, keep everything else identical".
- Output paths are printed on stdout; progress on stderr.

## How it works

Playwright WebKit with the saved Google `storageState`. Per scene: open a fresh
composer → `Upload & tools` → upload scene + ref via the OS file chooser → type the edit task →
submit → poll for the new large image → download (handles blob: and http URLs).

## Failure modes

- `no upload trigger` / all menu items greyed → **logged out**, re-capture the session (see above).
- `no image (timeout)` → Gemini refused or returned text; check the logged `tail:` and `/tmp/gem_err.png`.
- UI label drift: the upload button / menu labels change (IT⇄EN). Selectors match both via regex; extend if Google renames them again.

## Provenance

Built for a client's corporate shoot (logo-swap on 7 scene shots) after confirming ChatGPT
consumer cannot reference-edit. Generalized here as the standard logo/object-swap tool.
