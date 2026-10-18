// Build ASS captions file from ElevenLabs alignment JSON.
// Uses PlayRes 1080x1920 so MarginV/FontSize map to actual pixels.
// Position: ~400px from bottom (safe zone above Instagram/TikTok UI).
// usage: node ass.js <alignment.json> <out.ass> [LEAD_SEC]
const fs = require('fs');

const [, , ALIGN, OUT, LEAD_ARG] = process.argv;
if (!ALIGN || !OUT) {
  console.error('usage: node ass.js <alignment.json> <out.ass> [LEAD_SEC]');
  process.exit(1);
}
const lead = parseFloat(LEAD_ARG || '0');
const MAX_CHARS = 26;

const raw = JSON.parse(fs.readFileSync(ALIGN, 'utf8'));
const chars = raw.characters;
const starts = raw.character_start_times_seconds;
const ends = raw.character_end_times_seconds;

const phrases = [];
let cur = { text: '', start: null, end: null };

function flush() {
  const t = cur.text.trim();
  if (t) phrases.push({ text: t, start: cur.start, end: cur.end });
  cur = { text: '', start: null, end: null };
}
for (let i = 0; i < chars.length; i++) {
  const c = chars[i];
  if (cur.start === null) cur.start = starts[i];
  cur.text += c;
  cur.end = ends[i];
  const hard = /[.?!\n]/.test(c);
  const soft = c === ',' && cur.text.length >= 18;
  const hitMax = cur.text.length >= MAX_CHARS && c === ' ';
  if (hard || soft || hitMax) flush();
}
flush();

function fmtASS(s) {
  const t = Math.max(0, s + lead);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}

function clean(s) {
  return s.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Impact,78,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,7,2,2,60,60,380,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const events = phrases
  .map(p => `Dialogue: 0,${fmtASS(p.start)},${fmtASS(p.end)},Default,,0,0,0,,${clean(p.text)}`)
  .join('\n');

fs.writeFileSync(OUT, header + events + '\n');
console.log(`${phrases.length} events → ${OUT}`);
