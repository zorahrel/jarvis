#!/usr/bin/env bash
# Assemble scrolling 9:16 MP4 from a tall PNG + MP3 voiceover + optional SRT burn-in.
# usage: assemble.sh <readme.png> <voice.mp3> <out.mp4> [captions.srt]
set -euo pipefail

IMG="${1:?readme.png}"
AUDIO="${2:?voice.mp3}"
OUT="${3:?out.mp4}"
SRT="${4:-}"

DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$AUDIO")
[[ -z "$DUR" ]] && { echo "ERROR: couldn't read audio duration" >&2; exit 3; }

DIMS=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$IMG")
IMG_W="${DIMS%x*}"
IMG_H="${DIMS#*x}"

LEAD=0.6
TAIL=0.5
TOTAL=$(awk -v d="$DUR" -v l="$LEAD" -v t="$TAIL" 'BEGIN{printf "%.3f", d+l+t}')

VP_W=1080
VP_H=1920

SCALED_H=$(awk -v h="$IMG_H" -v w="$IMG_W" -v vw="$VP_W" 'BEGIN{printf "%d", h*vw/w}')
MAX_Y=$(( SCALED_H - VP_H ))
[[ $MAX_Y -lt 0 ]] && MAX_Y=0

echo "→ assemble: audio=${DUR}s, total=${TOTAL}s, scaled=${VP_W}x${SCALED_H}, max_y=${MAX_Y}${SRT:+, captions=$SRT}"

# Scrolling crop: hold for LEAD, scroll during DUR, hold for TAIL
SCROLL="[0:v]scale=${VP_W}:${SCALED_H}:flags=lanczos,\
crop=${VP_W}:${VP_H}:0:'if(lt(t,${LEAD}),0, if(gt(t,${LEAD}+${DUR}), ${MAX_Y}, ${MAX_Y}*(t-${LEAD})/${DUR}))',\
format=yuv420p"

if [[ -n "$SRT" && -f "$SRT" ]]; then
  SUB_ESC=$(echo "$SRT" | sed 's|:|\\\\:|g')
  if [[ "$SRT" == *.ass ]]; then
    # ASS file already embeds PlayRes + Style — do not override.
    FILTER="${SCROLL},ass='${SUB_ESC}'[v]"
  else
    STYLE="FontName=Impact,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=1,Outline=4,Shadow=1,Alignment=2,MarginV=70,Bold=1,Spacing=0.5"
    FILTER="${SCROLL},subtitles='${SUB_ESC}':force_style='${STYLE}'[v]"
  fi
else
  FILTER="${SCROLL}[v]"
fi

DELAY_MS=$(awk -v l="$LEAD" 'BEGIN{printf "%d", l*1000}')

ffmpeg -hide_banner -loglevel warning -y \
  -loop 1 -framerate 30 -i "$IMG" \
  -i "$AUDIO" \
  -filter_complex "$FILTER" \
  -map "[v]" -map 1:a \
  -c:v libx264 -preset medium -crf 20 -r 30 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -af "adelay=${DELAY_MS}|${DELAY_MS}" \
  -t "$TOTAL" \
  -movflags +faststart \
  "$OUT"

BYTES=$(wc -c <"$OUT" | tr -d ' ')
SIZE_MB=$(awk -v b="$BYTES" 'BEGIN{printf "%.2f", b/1024/1024}')
echo "✓ $OUT (${SIZE_MB} MB, ${TOTAL}s, ${VP_W}x${VP_H})"
