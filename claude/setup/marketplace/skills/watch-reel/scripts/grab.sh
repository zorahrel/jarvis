#!/bin/zsh
# Download a video and extract keyframes for Claude to Read.
# Usage: grab.sh <url> [name] [--cookies <file>]
# Env: OUTDIR (default: a temp dir). Prints keyframe paths on stdout.
set -euo pipefail

URL="${1:-}"; NAME="${2:-clip}"
[[ "$NAME" == --* ]] && { NAME="clip"; }
COOKIES=""
[[ "${2:-}" == "--cookies" ]] && COOKIES="${3:-}"
[[ "${3:-}" == "--cookies" ]] && COOKIES="${4:-}"
[[ -n "$URL" ]] || { echo "usage: grab.sh <url> [name] [--cookies <file>]" >&2; exit 1; }

OUTDIR="${OUTDIR:-$(mktemp -d)}"
mkdir -p "$OUTDIR"
VID="$OUTDIR/$NAME.mp4"

# yt-dlp MUST run under python 3.13 (brew py3.14 has broken pyexpat).
YTDLP=(uvx --python 3.13 yt-dlp --no-warnings -f "mp4/best" -o "$VID")
[[ -n "$COOKIES" ]] && YTDLP+=(--cookies "$COOKIES")
"${YTDLP[@]}" "$URL" >&2

[[ -f "$VID" ]] || { echo "download failed" >&2; exit 1; }
ffmpeg -i "$VID" -vf "fps=1,scale=720:-1" "$OUTDIR/${NAME}_%02d.png" -hide_banner -loglevel error
echo "# video: $VID" >&2
echo "# keyframes (Read these, or 'tesseract <f> -' to grep URLs):" >&2
ls "$OUTDIR/${NAME}_"*.png
