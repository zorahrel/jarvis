// Mette in fila, per finestra da 15 min: pavimento dell'old_space (minimo dei campioni da 30 s, cioè dopo i GC),
// build di plugin create, turni di conversazione e byte sopravvissuti per categoria nel profilo (23/10).
// Uso: node align.mjs [cartella] [owner]   (default ~/.cache/oc-heapwatch/cont; owner = prefisso della cartella
// del gateway sotto plugin-captures: le altre sono CLI di passaggio che creano e cancellano build in un minuto)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = process.argv[2] || path.join(os.homedir(), '.cache', 'oc-heapwatch', 'cont');
const owner = process.argv[3] || '';
const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean) : []);
const stab = read('stability.jsonl').map((l) => JSON.parse(l));
const mem = stab.filter((e) => e.type === 'mem');
const turns = stab.filter((e) => e.type === 'session.turn.created');
const caps = read('captures.log').map((l) => l.split(' ')).filter((p) => (p[1] === '+' || p[1] === '-') && p[2].startsWith(owner)).map(([t, sign, name]) => ({ ts: Date.parse(t), sign, name }));
// il footprint può andare a capo (grep -o su due righe): si ricuce prima di leggere ogni riga
const windows = fs.existsSync(path.join(dir, 'windows.jsonl'))
  ? fs.readFileSync(path.join(dir, 'windows.jsonl'), 'utf8').replace(/\n(?!\{"start")/g, ' ').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const cats = [
  ['plugin', /plugin-generation-artifact|plugin-source-capture|plugin-setup-module|node:internal\/modules\/esm|module_job|translators/],
  ['session', /session-accessor|get-reply|agent-runner|session-store|user-turn-transcript/],
  ['skills', /plugin-skills|skill/],
  ['config', /runtime-source-projection|captureRuntimeConfig/],
];
const survived = (file) => {
  const d = JSON.parse(fs.readFileSync(path.join(dir, file)));
  const out = { total: 0 };
  const add = (urls, size) => { out.total += size; const c = (cats.find(([, re]) => re.test(urls)) || ['other'])[0]; out[c] = (out[c] || 0) + size; };
  if (d.profile) {
    const stacks = new Map();
    (function walk(n, trail) { const t = [`${n.callFrame?.url || ''} ${n.callFrame?.functionName || ''}`, ...trail].slice(0, 12); stacks.set(n.id, t.join(' ')); for (const c of n.children || []) walk(c, t); })(d.profile.head, []);
    for (const s of d.profile.samples) add(stacks.get(s.nodeId) || '', s.size);
  } else for (const r of d.summary || []) add(r.stack.map((c) => `${c.url || ''} ${c.functionName || ''}`).join(' '), r.selfBytes);
  return { out, durationMs: d.durationMs };
};
const mb = (b) => Math.round(b / 1e6);
console.log('fine finestra        floor  Δfloor  build+  build-  turni  sopravv (plugin/session/skills/config/other)');
let prevFloor;
for (const w of windows) {
  const { out, durationMs } = survived(w.file);
  const end = Date.parse(w.end);
  const start = end - durationMs;
  const inWin = (e) => e.ts >= start && e.ts < end;
  const floor = Math.min(...mem.filter(inWin).map((e) => e.old));
  const added = caps.filter((c) => inWin(c) && c.sign === '+').length;
  const removed = caps.filter((c) => inWin(c) && c.sign === '-').length;
  const delta = Number.isFinite(floor) && prevFloor !== undefined ? floor - prevFloor : '';
  console.log(w.end.slice(5, 16), String(Number.isFinite(floor) ? floor : '-').padStart(7), String(delta).padStart(7), String(added).padStart(7), String(removed).padStart(7), String(turns.filter(inWin).length).padStart(6),
    `  ${mb(out.total)} (${['plugin', 'session', 'skills', 'config', 'other'].map((k) => mb(out[k] || 0)).join('/')})`);
  if (Number.isFinite(floor)) prevFloor = floor;
}
