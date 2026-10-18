#!/usr/bin/env bash
# Generate MP3 + char-level alignment JSON from a script via ElevenLabs.
# usage: tts.sh <script.txt> <out.mp3> [voice_id]
# Also writes: <out.mp3>.alignment.json
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/_lib.sh"

SCRIPT_FILE="${1:?usage: tts.sh <script.txt> <out.mp3> [voice_id]}"
OUT="${2:?missing output path}"
VOICE_ID_OVERRIDE="${3:-}"

[[ -f "$SCRIPT_FILE" ]] || { echo "script file $SCRIPT_FILE missing" >&2; exit 1; }

CFG=$(get_eleven_cfg)
KEY=$(echo "$CFG" | jq -r '.apiKey')
VOICE_ID="${VOICE_ID_OVERRIDE:-$(echo "$CFG" | jq -r '.voiceId')}"
MODEL=$(echo "$CFG" | jq -r '.modelId // "eleven_multilingual_v2"')
LANG=$(echo "$CFG" | jq -r '.languageCode // "en"')

TEXT=$(cat "$SCRIPT_FILE")
CHARS=${#TEXT}
echo "→ TTS: $CHARS chars, voice=$VOICE_ID, model=$MODEL, lang=$LANG"

PAYLOAD=$(jq -n --arg t "$TEXT" --arg m "$MODEL" --arg l "$LANG" \
  '{text: $t, model_id: $m, language_code: $l, voice_settings: {stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true}}')

RESP=$(mktemp -t tts-resp.XXXXXX.json)
trap 'rm -f "$RESP"' EXIT

HTTP=$(curl -sS -w '%{http_code}' -o "$RESP" \
  -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128" \
  -H "xi-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

if [[ "$HTTP" != "200" ]]; then
  echo "ERROR: ElevenLabs HTTP $HTTP" >&2
  head -c 500 "$RESP" >&2 2>/dev/null || true
  exit 3
fi

# Extract audio and alignment
jq -r '.audio_base64' "$RESP" | base64 -D > "$OUT" 2>/dev/null || jq -r '.audio_base64' "$RESP" | base64 -d > "$OUT"
jq '.normalized_alignment // .alignment' "$RESP" > "${OUT}.alignment.json"

SIZE=$(wc -c <"$OUT" | tr -d ' ')
DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null || echo "?")
CHAR_COUNT=$(jq '.characters | length' "${OUT}.alignment.json")
echo "✓ $OUT (${SIZE} bytes, ${DUR}s, ${CHAR_COUNT} timed chars)"
echo "✓ ${OUT}.alignment.json"
