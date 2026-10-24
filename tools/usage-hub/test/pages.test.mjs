import '../test-support/isolate-tmp.mjs';
// Pagine nuove: «Ti aspetta» in Panoramica, Diario, Contesto, e «Risolvi tu». Dati finti, mai persone vere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pages-'));
process.env.USAGE_HUB_QUEUE = path.join(dir, 'queue.json');
process.env.USAGE_HUB_QUEUE_LOG = path.join(dir, 'queue.log');
process.env.USAGE_HUB_ATTESA = path.join(dir, 'ti-aspetta.jsonl');
process.env.USAGE_HUB_CONTEXT_CHECK = path.join(dir, 'check.json');

const { readAttesa, writeAttesa, validateAttesa, fromAutomations } = await import('../src/attesa.mjs');
const { journal, firstLine } = await import('../src/journal.mjs');
const { fixTask } = await import('../src/fix.mjs');
const { createServer } = await import('../src/server.mjs');
const require = createRequire(import.meta.url);
require('../public/pages-view.js');
const P = globalThis.PagesView;

const pb = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/automations/model-problemi.json'), 'utf8'));
const NOW = pb.checkedAt;

test('Ti aspetta: il registro apre e chiude; dalle automazioni entra solo il cancello di un workflow', () => {
  const file = path.join(dir, 'a1.jsonl');
  assert.match(validateAttesa({ tipo: 'boh', title: 'x' }), /tipo/);
  assert.match(validateAttesa({ tipo: 'spesa' }), /title/);
  assert.equal(validateAttesa({ kind: 'chiudi' }), 'manca ref della voce da chiudere');
  const a = writeAttesa({ tipo: 'spesa', title: 'Rinnovo dominio di prova', why: '12 euro l\'anno', from: 'agente' }, { file, now: 1000 });
  writeAttesa({ tipo: 'vista', title: 'Guarda la pagina nuova', link: '#overview' }, { file, now: 2000 });
  assert.deepEqual(readAttesa({ file }).map((x) => x.title), ['Rinnovo dominio di prova', 'Guarda la pagina nuova']);
  writeAttesa({ kind: 'chiudi', ref: a.id }, { file, now: 3000 });
  assert.deepEqual(readAttesa({ file }).map((x) => x.tipo), ['vista']);
  const gates = fromAutomations(pb);
  assert.ok(gates.length >= 1);
  assert.ok(gates.every((g) => g.tipo === 'decisione' && /^Ok al passo «/.test(g.title) && g.link.startsWith('#automations/')));
  // Gli avvisi delle automazioni (soglie, doctor) non sono decisioni sue: restano fuori.
  const te = Object.values(pb.cards).filter((c) => c.level === 'te' && !/passo «/.test(c.reason || ''));
  for (const c of te) assert.ok(!gates.some((g) => g.id === 'auto:' + c.key));
});

test('Ti aspetta in Panoramica: card con tipo, azioni e Jarvis; stato vuoto che regge', () => {
  require('../public/icons.js');
  const cfg = { jarvis: { whatsapp: 'https://wa.me/390000000000' } };
  const h = P.attesaHtml({ items: [{ id: 'x1', tipo: 'pubblico', title: 'Pubblicare il post di prova', why: 'va sul sito', from: 'agente', at: NOW - 7200000, link: 'https://example.com/bozza' }] }, cfg, NOW);
  assert.match(h, /data-sec="wait"/);
  assert.match(h, /Va in pubblico/);
  assert.match(h, /2 ore fa/);
  assert.match(h, /data-wait-done="x1"/);
  assert.match(h, /href="https:\/\/wa\.me\/390000000000\?text=Su%20%C2%AB/);
  const empty = P.attesaHtml({ items: [] }, {}, NOW);
  assert.match(empty, /Niente ti aspetta/);
  assert.doesNotMatch(empty, /data-wait-done/);
  assert.match(P.attesaHtml(null, {}, NOW), /non risponde/);
  delete globalThis.Icons;
});

test('Diario: giri, workflow, lavori delegati e feedback in parole, il più recente in cima, senza telefoni', () => {
  const key = Object.keys(pb.cards)[0];
  const queue = [{ id: 'q1', task: 'Sistema la prova. Poi chiama +39 333 000 0000 se serve', status: 'done', provider: 'codex', createdAt: NOW - 5000, startedAt: NOW - 4000, endedAt: NOW - 1000, project: 'automazioni', ref: key }];
  const feedback = [{ id: 'f1', kind: 'fix', key, why: 'cambiato l\'orario, giro a mano ok', at: new Date(NOW - 500).toISOString() }, { id: 'f2', kind: 'vote', key, v: 'cambia', note: 'troppi avvisi', at: new Date(NOW - 9000).toISOString() }];
  const e = journal({ model: pb, queue, feedback, now: NOW, days: 7 });
  assert.ok(e.length > 3);
  for (let i = 1; i < e.length; i++) assert.ok(e[i - 1].at >= e[i].at, 'ordine dal più recente');
  const fix = e.find((x) => x.title.startsWith('Un agente ha sistemato'));
  assert.equal(fix.kind, 'agente');
  const job = e.find((x) => x.who === 'Agente · Codex');
  assert.equal(job.title, 'Sistema la prova.');
  assert.equal(job.outcome, 'ok');
  assert.match(job.what, /su /);
  assert.doesNotMatch(JSON.stringify(e), /333 000 0000/);
  assert.ok(e.some((x) => x.kind === 'auto' && x.link.startsWith('#automations/')));
  assert.ok(e.some((x) => x.title.startsWith('Hai detto «da cambiare»')));
  assert.equal(firstLine('a'.repeat(200), 20).length <= 20, true);
});

test('Diario, pagina: per giorno, filtro e ricerca; vuoto con messaggio', () => {
  require('../public/icons.js');
  const items = [
    { at: NOW - 60000, kind: 'auto', who: 'OpenClaw', title: 'Brief di prova', outcome: 'ok', what: 'ti è arrivato', link: '#automations/x' },
    { at: NOW - 120000, kind: 'agente', who: 'Agente · Muse', title: 'Riordina i test', outcome: 'error', what: 'uscito con codice 1', link: null },
    { at: NOW - 86400000 - 60000, kind: 'auto', who: 'Mac', title: 'Backup di prova', outcome: 'ok', what: '', link: '#automations/y' },
  ];
  const h = P.journalHtml({ days: 7, items }, {}, NOW);
  assert.match(h, /<h2 class="jd">Oggi<span>2 eventi, <em>1 fallito<\/em>/);
  assert.match(h, /<h2 class="jd">Ieri/);
  assert.match(h, /<a class="jr" href="#automations\/x">/);
  assert.equal((P.journalHtml({ days: 7, items }, { f: 'pb' }, NOW).match(/class="jr"/g) || []).length, 1);
  assert.equal((P.journalHtml({ days: 7, items }, { q: 'backup' }, NOW).match(/class="jr"/g) || []).length, 1);
  assert.match(P.journalHtml({ days: 7, items }, { q: 'nessuno' }, NOW), /Togli il filtro/);
  assert.match(P.journalHtml({ days: 7, items: [] }, {}, NOW), /non risulta nessun giro/);
  delete globalThis.Icons;
});

test('Contesto, pagina: token per harness, controlli, file per chi li carica, doppioni e date vecchie', () => {
  require('../public/icons.js');
  const r = {
    at: NOW,
    files: [
      { id: 'claude-md', label: 'CLAUDE.md globale', path: '~/.claude/CLAUDE.md', group: 'Claude Code', loaders: ['Claude Code'], chars: 8000, tokens: 2000, mtime: NOW - 86400000 },
      { id: 'oc:main:AGENTS.md', label: 'AGENTS.md · agente main', path: '~/.openclaw/AGENTS.md', group: 'OpenClaw', loaders: ['OpenClaw · main'], chars: 400, tokens: 100, mtime: NOW - 90 * 86400000 },
    ],
    skills: { count: 1, tokens: 50, loaders: ['Claude Code', 'Codex'], items: [{ name: 'prova', chars: 200, tokens: 50 }] },
    duplicates: [{ text: 'una regola ripetuta in due file', files: ['claude-md', 'oc:main:AGENTS.md'] }],
    oldRules: [{ file: 'claude-md', line: 12, text: 'regola del 01/01', date: '2026-01-01', days: 296 }],
    doctor: { ok: false, checks: [{ ok: true, text: 'a' }, { ok: false, text: 'link rotto: prova' }], error: null },
    totals: { byLoader: { 'Claude Code': 2050, 'OpenClaw · main': 150 } },
    contradictions: { at: null, items: [] },
  };
  const h = P.contextHtml(r);
  assert.match(h, /2,1k<\/span><span class="stat-l">token a sessione · Claude Code/);
  assert.match(h, /agents-doctor rosso/);
  assert.match(h, /link rotto: prova/);
  assert.match(h, /1 riga doppia/);
  assert.match(h, /2 controlli, 1 fallito/);
  assert.match(h, /in CLAUDE\.md globale, AGENTS\.md · agente main/);
  assert.match(h, /CLAUDE\.md globale, riga 12 · 296 giorni/);
  assert.match(h, /Contraddizioni mai controllate/);
  assert.match(h, /data-ctx-check="1"/);
  assert.match(h, /class="fd old"/);
  delete globalThis.Icons;
});

test('Risolvi tu: il compito porta chiave, motivo, dove guardare e come chiudere', () => {
  const c = Object.values(pb.cards).find((x) => x.level === 'rotto');
  const t = fixTask(c);
  assert.equal(t.ref, c.key);
  assert.equal(t.project, 'automazioni');
  assert.match(t.task, new RegExp(c.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(t.task, /Compito: trova la causa/);
  assert.match(t.task, /"kind":"fix"/);
  assert.match(t.task, /\/api\/attesa/);
});

test('API: /api/attesa, /api/diario, /api/fix, /api/contesto, /api/hub-config', async () => {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/CLAUDE.md'), '# prova\nuna regola di prova abbastanza lunga da contare come riga vera\n');
  const auto = { model: async () => pb, summary: async () => ({}), feedback: () => ({}), openFeedback: () => [] };
  const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] } }, { noLive: true, noQueue: true, automations: auto, feedbackDir: path.join(dir, 'fb'),
    contextOpts: { home, runDoctor: async () => ({ code: 0, stdout: 'ok   tutto' }) } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    assert.equal((await post('/api/attesa', { tipo: 'x', title: 'y' })).status, 400);
    const opened = await post('/api/attesa', { tipo: 'decisione', title: 'Scegli il nome della prova', from: 'test' });
    assert.equal(opened.status, 200);
    let a = await (await fetch(base + '/api/attesa')).json();
    assert.ok(a.items.some((x) => x.title === 'Scegli il nome della prova'));
    assert.ok(a.items.some((x) => x.auto), 'il cancello del workflow della fixture');
    await post('/api/attesa', { kind: 'chiudi', ref: opened.body.row.id });
    a = await (await fetch(base + '/api/attesa')).json();
    assert.ok(!a.items.some((x) => x.title === 'Scegli il nome della prova'));

    const c = Object.values(pb.cards).find((x) => x.level === 'rotto');
    const f1 = await post('/api/fix', { key: c.key });
    assert.equal(f1.body.ok, true);
    assert.equal(f1.body.item.ref, c.key);
    const f2 = await post('/api/fix', { key: c.key });
    assert.equal(f2.body.already, true, 'un secondo clic non accoda un doppione');
    assert.equal((await post('/api/fix', { key: 'nessuna' })).status, 404);

    const d = await (await fetch(base + '/api/diario?days=7')).json();
    assert.equal(d.days, 7);
    assert.ok(d.items.some((x) => x.ref === c.key && x.kind === 'agente'), 'il lavoro di Risolvi tu è nel diario');

    const ctx = await (await fetch(base + '/api/contesto')).json();
    assert.equal(ctx.files[0].id, 'claude-md');
    assert.equal(ctx.doctor.ok, true);
    assert.deepEqual(ctx.contradictions.items, []);
    assert.equal((await post('/api/contesto/check', {})).body.ok, false, 'in demo e nei test non parte nessun agente');

    const cfg = await (await fetch(base + '/api/hub-config')).json();
    assert.ok('jarvis' in cfg);
  } finally { srv.close(); }
});
