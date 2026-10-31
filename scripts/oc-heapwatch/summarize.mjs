// Somma i profili di oc-heapwatch: per ogni stack (ultimi 5 frame) quanta memoria sopravvive e in quante finestre.
// Uno stack che resta in quasi tutte le finestre è un candidato a trattenere memoria; uno in una sola è un picco.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir = path.join(os.homedir(), '.cache', 'oc-heapwatch');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const agg = new Map();
const name = (n) => { const c = n.callFrame || {}; return `${c.functionName || '(anon)'} ${String(c.url || '').split('/').pop()}:${c.lineNumber}`; };
// i profili troncati dal gateway (`truncated: true`) arrivano senza `profile`: si contano a parte
const skipped = [];
for (const f of files) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, f))).profile;
  if (!p) { skipped.push(f); continue; }
  const seen = new Map();
  (function walk(n, trail) {
    const k = name(n); const s = n.selfSize || 0;
    if (s) { const st = [...trail, k].filter((x) => !/^\(root\)|^\(anon\) :/.test(x)).slice(-5).join(' < '); seen.set(st, (seen.get(st) || 0) + s); }
    for (const c of n.children || []) walk(c, [...trail, k]);
  })(p.head, []);
  for (const [st, b] of seen) { const a = agg.get(st) || { bytes: 0, windows: 0 }; a.bytes += b; a.windows++; agg.set(st, a); }
}
const n = files.length - skipped.length;
console.log(`${n} finestre da 15 min${skipped.length ? ` (${skipped.length} troncate, saltate: ${skipped.join(' ')})` : ''}`);
for (const [st, a] of [...agg].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 25)) console.log(`${(a.bytes / 1e6).toFixed(1)} MB in ${a.windows}/${n}  ${st}`);
