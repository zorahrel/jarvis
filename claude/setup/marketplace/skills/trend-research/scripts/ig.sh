#!/usr/bin/env bash
# Instagram Reels scraper via Apify.
# Usage:
#   ig.sh hashtag <tag> [--limit N]
#   ig.sh profile <username> [--limit N]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/_lib.sh"

MODE="${1:-}"
TARGET="${2:-}"
LIMIT=30
shift 2 2>/dev/null || { echo "usage: ig.sh hashtag|profile <target> [--limit N]" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

SLUG=$(slug "${MODE}-${TARGET}")
OUT="/tmp/raw-ig-${SLUG}.json"
INPUT=$(mktemp -t ig-input.XXXXXX.json)
trap 'rm -f "$INPUT"' EXIT

case "$MODE" in
  hashtag)
    ACTOR="apify~instagram-hashtag-scraper"
    jq -n --arg tag "$TARGET" --argjson n "$LIMIT" \
      '{hashtags: [$tag], resultsLimit: $n}' > "$INPUT"
    ;;
  profile)
    ACTOR="apify~instagram-profile-scraper"
    jq -n --arg u "$TARGET" --argjson n "$LIMIT" \
      '{usernames: [$u], resultsLimit: $n}' > "$INPUT"
    ;;
  *) echo "mode must be hashtag|profile" >&2; exit 1 ;;
esac

echo "→ IG $MODE '$TARGET' (limit=$LIMIT) via $ACTOR"
apify_run_sync "$ACTOR" "$INPUT" "$OUT"

# Profile actor returns [{...profile..., latestPosts: [...]}]; flatten to posts list.
if [[ "$MODE" == "profile" ]]; then
  jq '[.[] | .latestPosts // []] | add // []' "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
fi

COUNT=$(jq 'length' "$OUT")
echo "✓ $COUNT items saved to $OUT"
echo "$OUT"
