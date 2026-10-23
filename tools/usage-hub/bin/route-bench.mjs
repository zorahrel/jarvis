#!/usr/bin/env node
// Banco del decisore della delega: compiti veri etichettati a mano (gusto/meccanico).
// Confronta tutti i decisori raggiungibili senza installare niente: i modelli TypeSafe elencati da /v1/models,
// i canali gratis del free-router come classificatore, le regole; più un controllo a etichette rimescolate.
// Stampa precisione (totale e sui soli compiti OpenClaw) e latenza mediana. Exit 0 se il migliore batte
// regole e controllo di almeno 15 punti.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { classifyByJev, classifyByRules, classifyByLLM } from '../src/route.mjs';

const bench = JSON.parse(fs.readFileSync(new URL('../test/fixtures/route-bench.json', import.meta.url)));
const labels = bench.map((b) => b.label);
const key = execFileSync('security', ['find-generic-password', '-s', 'typesafe', '-a', 'jev', '-w'], { encoding: 'utf8' }).trim();
const jevModels = (await (await fetch('https://api.typesafe.ai/v1/models', { headers: { Authorization: `Bearer ${key}` } })).json()).models.map((m) => m.name);

async function freeRouter(task) {
  const r = await fetch('http://127.0.0.1:18791/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model: 'free-auto', max_tokens: 800, temperature: 0, messages: [
      { role: 'system', content: 'Classify a task to delegate to an agent. Reply with exactly one word: taste (perceived quality matters: design, UI, logo, animation, copy for people, naming, judging if something is beautiful or faithful to a reference) or mechanical (verifiable work: search, read, extract, summarize, refactor, repetitive code, tests, configuration, deploy).' },
      { role: 'user', content: task.slice(0, 2000) }] }),
  });
  const t = ((await r.json()).choices?.[0]?.message?.content || '').toLowerCase();
  // i modelli che ragionano scrivono prima il ragionamento: conta l'ultima parola utile
  const last = Math.max(t.lastIndexOf('taste'), t.lastIndexOf('mechanical'));
  return last < 0 ? `? ${t.slice(0, 20)}` : t.startsWith('taste', last) ? 'taste' : 'mechanical';
}

const SYSTEM = 'Classify a task to delegate to an agent. Reply with exactly one word: taste (perceived quality matters: design, UI, logo, animation, copy for people, naming, judging if something is beautiful or faithful to a reference) or mechanical (verifiable work: search, read, extract, summarize, refactor, repetitive code, tests, configuration, deploy).';
const kc = (s) => { try { return execFileSync('security', ['find-generic-password', '-s', s, '-a', 'api-key', '-w'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
// Candidati online veloci (ricerca 18/10): stesso prompt dei canali gratis, una parola, temperatura 0.
function oai(base, key, model) {
  return async (task) => {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model, max_tokens: 400, temperature: 0, ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: task.slice(0, 2000) }] }),
    });
    const d = await r.json();
    const t = (d.choices?.[0]?.message?.content || d.error?.message || '').toLowerCase();
    const last = Math.max(t.lastIndexOf('taste'), t.lastIndexOf('mechanical'));
    return last < 0 ? `? ${t.slice(0, 30)}` : t.startsWith('taste', last) ? 'taste' : 'mechanical';
  };
}
const online = {};
const groq = kc('groq'); const cerebras = kc('cerebras');
if (groq) for (const m of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']) online[`groq ${m.split('/')[1]}`] = oai('https://api.groq.com/openai/v1', groq, m);
if (cerebras) for (const m of ['gpt-oss-120b', 'qwen-3.8-27b']) online[`cerebras ${m}`] = oai('https://api.cerebras.ai/v1', cerebras, m);

const deciders = {
  'router: groq gpt-oss-120b JSON': (t) => classifyByLLM(t, { timeoutMs: 30000 }).then((r) => r.cls),
  ...online,
  ...Object.fromEntries(jevModels.map((m) => [m, (t) => classifyByJev(t, { model: m, key, timeoutMs: 30000 }).then((r) => r.cls)])),
  'free-router': freeRouter,
  regole: async (t) => classifyByRules(t).cls,
};
const acc = (pred, idx = bench.map((_, i) => i)) => idx.filter((i) => pred[i] === labels[i]).length / idx.length;
const oc = bench.map((b, i) => (b.source === 'openclaw' ? i : -1)).filter((i) => i >= 0);
const pct = (x) => `${Math.round(x * 100)}%`.padStart(4);
const res = {};
for (const [name, fn] of Object.entries(deciders)) {
  const times = [];
  const pred = [];
  for (const b of bench) { // in serie: la latenza misurata è quella di una delega sola
    const t0 = Date.now();
    pred.push(await fn(b.task).catch((e) => `errore: ${e.message}`));
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  res[name] = { pred, all: acc(pred), oc: acc(pred, oc), ms: times[times.length >> 1] };
  console.log(`${name.padEnd(24)} tutti ${pct(res[name].all)} · OpenClaw ${pct(res[name].oc)} · mediana ${res[name].ms} ms`);
  bench.forEach((b, i) => { if (pred[i] !== b.label) console.log(`    sbaglia: atteso ${b.label}, dice ${pred[i]} · ${b.task.slice(0, 70).replace(/\n/g, ' ')}`); });
}
const best = Object.entries(res).filter(([n]) => n !== 'regole').sort((a, b) => b[1].all - a[1].all || a[1].ms - b[1].ms)[0];
let shuffled = 0;
for (let k = 0; k < 500; k++) {
  const l = [...labels];
  for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
  shuffled += best[1].pred.filter((p, i) => p === l[i]).length / l.length / 500;
}
console.log(`migliore: ${best[0]} · controllo rimescolato ${pct(shuffled)}`);
const ok = best[1].all - res.regole.all >= 0.15 && best[1].all - shuffled >= 0.15;
console.log(ok ? 'VERDE: il migliore batte regole e controllo di almeno 15 punti' : 'ROSSO: nessun decisore stacca abbastanza le regole');
// ROUTE_BENCH_JSON=file: riepilogo per il controllo settimanale (bin/route-bench-weekly)
if (process.env.ROUTE_BENCH_JSON) fs.writeFileSync(process.env.ROUTE_BENCH_JSON, JSON.stringify({ at: Date.now(), best: best[0], ok, jevModels,
  results: Object.fromEntries(Object.entries(res).map(([n, r]) => [n, { all: r.all, oc: r.oc, ms: r.ms }])) }, null, 1));
process.exit(ok ? 0 : 1);
