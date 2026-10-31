#!/usr/bin/env bash
set -euo pipefail
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

get_eleven_cfg() {
  # Prints JSON: {apiKey, voiceId, modelId, languageCode}
  [[ -f "$OPENCLAW_CONFIG" ]] || { echo "ERROR: $OPENCLAW_CONFIG missing" >&2; exit 2; }
  local cfg
  cfg=$(jq -c '[.. | objects | select(.elevenlabs?) | .elevenlabs] | .[0] // empty' "$OPENCLAW_CONFIG")
  [[ -z "$cfg" || "$cfg" == "null" ]] && { echo "ERROR: elevenlabs block not found in $OPENCLAW_CONFIG" >&2; exit 2; }
  local key
  key=$(echo "$cfg" | jq -r '.apiKey // empty')
  [[ -z "$key" || "$key" == "null" ]] && { echo "ERROR: elevenlabs.apiKey missing" >&2; exit 2; }
  echo "$cfg"
}

slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/-\+/-/g; s/^-//; s/-$//'
}

