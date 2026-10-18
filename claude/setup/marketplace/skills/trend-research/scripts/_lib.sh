#!/usr/bin/env bash
# Shared: read Apify token (env, Keychain, openclaw config). Never echo it.
set -euo pipefail

OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

get_apify_token() {
  if [[ -n "${APIFY_TOKEN:-}" ]]; then
    echo "$APIFY_TOKEN"
    return 0
  fi
  # La chiave vive nel Keychain dall'08/10/2026; openclaw.json resta come ripiego
  if token=$(security find-generic-password -s apify -a token -w 2>/dev/null) && [[ -n "$token" ]]; then
    echo "$token"
    return 0
  fi
  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    echo "ERROR: no APIFY_TOKEN env and no $OPENCLAW_CONFIG" >&2
    exit 2
  fi
  local token
  token=$(jq -r '.. | .apify? | .apiToken? // .token? // empty' "$OPENCLAW_CONFIG" 2>/dev/null | grep -v '^$' | head -1)
  if [[ -z "$token" || "$token" == "null" ]]; then
    echo "ERROR: apify.apiToken not found in $OPENCLAW_CONFIG" >&2
    echo "Add under a 'apify' key with 'apiToken': '...'  (see rules/install.md)" >&2
    exit 2
  fi
  echo "$token"
}

apify_run_sync() {
  # $1 = actor slug (user~name format), $2 = JSON input file, $3 = output file
  local actor="$1" input="$2" output="$3"
  local token
  token=$(get_apify_token)
  curl -sS -X POST \
    "https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}&format=json" \
    -H "Content-Type: application/json" \
    -d @"$input" \
    -o "$output"
  if [[ ! -s "$output" ]]; then
    echo "ERROR: empty response from Apify actor $actor" >&2
    exit 3
  fi
  echo "$output"
}

slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/-\+/-/g; s/^-//; s/-$//'
}
