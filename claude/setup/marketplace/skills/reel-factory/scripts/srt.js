// Build SRT captions from ElevenLabs character-level alignment JSON.
// Splits on sentence punctuation and length-capped chunks so captions don't overflow mobile screens.
// usage: node srt.js <alignment.json> <out.srt> [LEAD_SEC]
const fs = require('fs');

const [, , ALIGN, OUT, LEAD_ARG] = process.argv;
if (!ALIGN || !OUT) {
  console.error('usage: node srt.js <alignment.json> <out.srt> [LEAD_SEC]');
  process.exit(1);
}
const lead = parseFloat(LEAD_ARG || '0');
const MAX = 28; // max chars per caption so big fonts fit 9:16

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
  const soft = c === ',' && cur.text.length >= 20;
  const hitMax = cur.text.length >= MAX && c === ' ';
  if (hard || soft || hitMax) flush();
}
flush();

function fmt(s) {
  const t = Math.max(0, s + lead);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function clean(s) {
  return s.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

const srt = phrases
  .map((p, i) => `${i + 1}\n${fmt(p.start)} --> ${fmt(p.end)}\n${clean(p.text)}\n`)
  .join('\n');

fs.writeFileSync(OUT, srt);
console.log(`${phrases.length} captions → ${OUT}`);
