#!/usr/bin/env bash
# Render a ranked markdown report from a raw Apify JSON dataset.
# Auto-detects IG vs TikTok shape. Sort key: plays/views DESC, fallback likes.
set -euo pipefail
RAW="${1:-}"
[[ -z "$RAW" || ! -f "$RAW" ]] && { echo "usage: report.sh <raw.json>" >&2; exit 1; }

# Normalize both shapes into a common intermediate list.
NORM=$(jq '[.[] | {
  url: (.url // .videoUrl // .webVideoUrl // .postUrl // ""),
  caption: (.caption // .text // .title // "" | tostring),
  plays: (.playCount // .videoPlayCount // .videoViewCount // .viewCount // 0),
  likes: (.likesCount // .diggCount // .likeCount // 0),
  comments: (.commentsCount // .commentCount // 0),
  shares: (.shareCount // .sharesCount // 0),
  author: (.ownerUsername // .authorMeta.name // .author.uniqueId // ""),
  timestamp: (.timestamp // .createTime // .takenAt // ""),
  hashtags: ([.hashtags // (.hashtags // []) // []] | flatten | .[0:5])
}]' "$RAW")

COUNT=$(echo "$NORM" | jq 'length')
TOTAL_PLAYS=$(echo "$NORM" | jq '[.[].plays] | add // 0')
MEDIAN_PLAYS=$(echo "$NORM" | jq '[.[].plays] | sort | .[(length/2|floor)] // 0')

echo "# Trend report"
echo ""
echo "- Source: \`$RAW\`"
echo "- Items: $COUNT"
echo "- Total plays: $TOTAL_PLAYS"
echo "- Median plays: $MEDIAN_PLAYS"
echo ""
echo "## Top 10 by views"
echo ""

echo "$NORM" | jq -r '
  sort_by(-.plays) | .[0:10] | to_entries[] |
  "### \(.key + 1). @\(.value.author) — \(.value.plays | tostring) plays, \(.value.likes | tostring) likes\n\n\(.value.url)\n\n> \(.value.caption | gsub("\n"; " ") | .[0:280])\n"
'

echo ""
echo "## All items (table)"
echo ""
echo "| # | author | plays | likes | comments | url |"
echo "|---|---|---:|---:|---:|---|"
echo "$NORM" | jq -r '
  sort_by(-.plays) | to_entries[] |
  "| \(.key + 1) | @\(.value.author) | \(.value.plays) | \(.value.likes) | \(.value.comments) | \(.value.url) |"
'
