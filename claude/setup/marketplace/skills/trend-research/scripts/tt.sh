#!/usr/bin/env bash
# TikTok scraper via Apify (clockworks/free-tiktok-scraper — free actor).
# Usage:
#   tt.sh hashtag <tag> [--limit N]
#   tt.sh profile <username> [--limit N]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/_lib.sh"

MODE="${1:-}"
TARGET="${2:-}"
LIMIT=50
shift 2 2>/dev/null || { echo "usage: tt.sh hashtag|profile <target> [--limit N]" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

SLUG=$(slug "${MODE}-${TARGET}")
OUT="/tmp/raw-tt-${SLUG}.json"
INPUT=$(mktemp -t tt-input.XXXXXX.json)
trap 'rm -f "$INPUT"' EXIT

ACTOR="clockworks~free-tiktok-scraper"
case "$MODE" in
  hashtag)
    jq -n --arg t "$TARGET" --argjson n "$LIMIT" \
      '{hashtags: [$t], resultsPerPage: $n, shouldDownloadVideos: false, shouldDownloadCovers: false}' > "$INPUT"
    ;;
  profile)
    jq -n --arg u "$TARGET" --argjson n "$LIMIT" \
      '{profiles: [$u], resultsPerPage: $n, shouldDownloadVideos: false, shouldDownloadCovers: false}' > "$INPUT"
    ;;
  *) echo "mode must be hashtag|profile" >&2; exit 1 ;;
esac

echo "→ TikTok $MODE '$TARGET' (limit=$LIMIT) via $ACTOR"
apify_run_sync "$ACTOR" "$INPUT" "$OUT"
COUNT=$(jq 'length' "$OUT")
echo "✓ $COUNT items saved to $OUT"
echo "$OUT"
