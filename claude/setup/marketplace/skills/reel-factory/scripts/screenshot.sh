#!/usr/bin/env bash
# Capture full-page PNG of a URL with WebKit (Playwright). Chrome is banned on this Mac.
# usage: screenshot.sh <URL> <OUT.png>
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

URL="${1:?URL}"
OUT="${2:?OUT}"
MOBILE_FLAG=""
[[ "${3:-}" == "--mobile" ]] && MOBILE_FLAG="--mobile"

cd "$DIR/.."
if [[ ! -d node_modules/playwright-core ]]; then
  echo "→ installing playwright-core (one-off)"
  (cd "$DIR/.." && bun install --silent >/dev/null)
fi

echo "→ screenshot $URL → $OUT ${MOBILE_FLAG}"
RESULT=$(node "$DIR/screenshot.js" "$URL" "$OUT" 4000 $MOBILE_FLAG)
HEIGHT=$(echo "$RESULT" | awk '{print $2}')
[[ -s "$OUT" ]] || { echo "ERROR: empty screenshot" >&2; exit 3; }
echo "✓ $OUT (${HEIGHT}px tall)"
echo "$HEIGHT"
