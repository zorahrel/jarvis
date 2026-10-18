---
name: watch-reel
description: |
  Leggi cosa mostra un video/reel (nome repo, tool, URL a schermo) scaricandolo ed estraendo keyframe che Claude legge. Triggers: "cosa dice questo reel/video", "estrai il repo dal video IG/TikTok", "gated repo dal video", "leggi lo schermo di questa reel". Gestisce contenuti loggati via cookie del browser reale. NON per generare video, NON per audio/trascrizione lunga.
allowed-tools: Bash(~/jarvis/skills-marketplace/skills/watch-reel/scripts/*), Bash(uvx *), Bash(ffmpeg *), Bash(tesseract *), Bash(jbrowser *), Read
---

# watch-reel — leggi il testo/contenuto a schermo di un video

Pipeline leggero (no video-model, no ML pesante): scarica il video → estrae
keyframe con ffmpeg → **li legge Claude** (Read, vision) o tesseract per grep.
Per link/nomi-repo che appaiono scritti nel video (es. reel Instagram con
"link in bio" o gated dietro commento).

## Quando NON usarlo
- Generare video (non è questo). Trascrizione audio lunga (usa whisper).
- Se il nome è già nella caption/commenti: leggilo da lì, non serve il video.

## Uso
`scripts/grab.sh <url> [nome]` → scarica in scratchpad, estrae keyframe (fps=1),
stampa i path. Poi **leggi i keyframe** col Read (o `tesseract <frame> -` per grep
veloce di URL/github).

## Contenuti loggati (Instagram, ecc.)
1. **Cookie: scansiona TUTTI i browser** (vedi feedback `browser-session-scan-all`):
   `jbrowser import-chrome ig --browser <b> --domains sito.com --dry-run` su
   chrome/dia/arc/brave/edge → vince quello con più cookie (spesso Arc, non Chrome).
2. Import reale dal vincitore, poi `jbrowser save-state ig h --origins https://sito`
   → converti in Netscape con `scripts/cookies_to_netscape.py` → passa a yt-dlp
   con `--cookies`.

## Vincoli ambiente
- **yt-dlp: `yt-dlp` di sistema funziona** (fix radice 2026-07-02: `pyexpat.so`
  di python@3.14 rilinkato all'expat di brew). Fallback se si rompe di nuovo
  (es. dopo `brew upgrade python@3.14` che revert-a il fix):
  `uvx --python 3.13 yt-dlp`. Vedi memory `video-ocr-reels`.
- ffmpeg, tesseract, uv già installati.
- Screenshot via browser NON funzionano per i frame video (headless → bianco):
  serve scaricare il file e ffmpeg, non `jbrowser shot`.

## Note
- I gated "commenta X per il link" spesso mostrano comunque il repo NEL video
  (screen-recording della pagina GitHub) → keyframe + Read lo becca.
  Ma alcuni NON lo mostrano affatto (link solo in DM): in quel caso non c'è.
- Pulisci lo scratchpad dopo (`rm` dei .mp4/.png), non lasciare video in giro.
