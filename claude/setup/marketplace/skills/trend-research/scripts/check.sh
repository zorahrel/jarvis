#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/_lib.sh"

TOKEN=$(get_apify_token)
echo "✓ Apify token found (len=${#TOKEN})"

RESP=$(curl -sS "https://api.apify.com/v2/users/me?token=${TOKEN}")
USERNAME=$(echo "$RESP" | jq -r '.data.username // empty')
PLAN=$(echo "$RESP" | jq -r '.data.plan.tier // .data.plan.id // empty')

if [[ -z "$USERNAME" ]]; then
  echo "✗ Token rejected. Response:"
  echo "$RESP" | jq . 2>/dev/null || echo "$RESP"
  exit 1
fi

echo "✓ Authenticated as '$USERNAME' (plan: $PLAN)"

USAGE=$(curl -sS "https://api.apify.com/v2/users/me/usage/monthly?token=${TOKEN}")
CREDITS_USED=$(echo "$USAGE" | jq -r '.data.monthlyUsage.totalUsageUsd // 0')
echo "  Month-to-date usage: \$${CREDITS_USED}"
