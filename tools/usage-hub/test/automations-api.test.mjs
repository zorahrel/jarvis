import '../test-support/isolate-tmp.mjs';
// API della scheda Automazioni con fonti finte: copia di 60 s, riepilogo per la tray, fonti lente che valgono «?»
// finché non hanno finito il primo giro, feedback scritto solo da questa macchina.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auto-api-'));
process.env.USAGE_HUB_QUEUE = path.join(dir, 'queue.json');
const { createServer } = await import('../src/server.mjs');
const { createAutomations } = await import('../src/automations/index.mjs');

const NOW = 1792764000000;
const item = (key, over = {}) => ({ key, provider: key.split(':')[0] === 'cron' ? 'openclaw' : 'launchd', name: key, enabled: true, everyMs: 86400000, when: 'ogni giorno alle 4:32',
  next: NOW + 3600000, nextApprox: false, expectedLast: null, last: { at: NOW - 3600000, outcome: 'ok', delivered: 'none', error: null },
  runs: [{ at: NOW - 3600000, outcome: 'ok' }], consecutiveErrors: 0, runsToday: 3, who: 'script: prova.sh', reportsTo: 'nessun messaggio',
  tech: { schedule: '32 4 * * *', exit: 0, command: 'prova.sh', prompt: null, label: key, url: null }, ...over });
const desc = {
  'cron:aaaa0001-0000-4000-8000-000000000001': { titolo: 'Prova che va', group: 'dati', cosa: 'Una prova che va.', tiScrive: 'mai' },
  'cron:aaaa0002-0000-4000-8000-000000000002': { titolo: 'Prova rotta', group: 'arriva', cosa: 'Una prova che fallisce.', tiScrive: 'WhatsApp' },
};
let builds = 0;
const pending = { read: () => ({ ok: false, pending: true, at: null, items: [] }), refresh: async () => {} };
const auto = createAutomations({
  now: () => NOW, background: false, feedbackDir: path.join(dir, 'fb'), agentsDir: path.join(dir, 'none'),
  launchctlList: async () => '123\t0\tai.openclaw.gateway\n', readDescriptions: () => desc, readHealth: () => { throw new Error('nessuno'); },
  openclaw: () => { builds++; return { ok: true, at: NOW, items: [item('cron:aaaa0001-0000-4000-8000-000000000001'), item('cron:aaaa0002-0000-4000-8000-000000000002', { last: { at: NOW - 3600000, outcome: 'error', delivered: 'none', error: 'x' }, runs: [{ at: NOW - 3600000, outcome: 'error' }], consecutiveErrors: 1, tech: { schedule: 'x', exit: 1, command: 'y', prompt: null, label: 'z', url: null } })] }; },
  desktop: () => ({ ok: true, at: NOW, items: [] }), workflows: () => ({ ok: true, at: NOW, items: [], runs: [] }), counted: async () => ({ ok: true, at: NOW, counts: { codex: 0, jcode: 0, topics: 0 } }),
  github: pending, pc: pending,
});

async function withServer(fn) {
  const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] } }, { noLive: true, automations: auto });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('GET /api/automations: modello con verdetto, seconda richiesta dalla copia', () => withServer(async (base) => {
  const a = await (await fetch(base + '/api/automations')).json();
  assert.equal(a.verdict.broken, 1);
  assert.equal(a.broken[0].title, 'Prova rotta');
  assert.equal(a.groups.length, 5);
  const n = builds;
  await fetch(base + '/api/automations');
  assert.equal(builds, n, 'entro 60 s non si rilegge niente');
}));

test('GitHub e PC prima del primo giro in background valgono «?», mai verde', () => withServer(async (base) => {
  const s = await (await fetch(base + '/api/automations/summary')).json();
  assert.deepEqual(Object.keys(s).sort(), ['broken', 'checkedAt', 'hidden', 'needsYou', 'ok', 'runsToday', 'sources']);
  const gh = s.sources.find((x) => x.name === 'github');
  assert.equal(gh.ok, false);
}));

test('POST /api/feedback: Origin estranea 403, curl locale passa, ?open=1 lo vede', () => withServer(async (base) => {
  const body = JSON.stringify({ kind: 'note', key: 'cron:aaaa0001-0000-4000-8000-000000000001', note: 'una nota di prova' });
  const bad = await fetch(base + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body });
  assert.equal(bad.status, 403);
  const ok = await fetch(base + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(ok.status, 200);
  const open = await (await fetch(base + '/api/feedback?open=1')).json();
  assert.equal(open.length, 1);
  const invalid = await fetch(base + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'vote', key: 'k', v: 'cambia' }) });
  assert.equal(invalid.status, 400, 'da cambiare senza nota è rifiutato');
}));
