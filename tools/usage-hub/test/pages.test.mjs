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
process.env.USAGE_HUB_DIARIO = path.join(dir, 'diario-api');

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

test('Computer e app: Mac, PC e Topics fuori da problemi, verdetto, «Ti aspetta» e filtro Problemi del diario', async () => {
  const { buildModel } = await import('../src/automations/model.mjs');
  require('../public/automations-view.js');
  const V = globalThis.AutomationsView;
  const H = 3600000;
  const mk = (key, outcome) => ({ key, provider: key.startsWith('gh:') ? 'github' : 'launchd', name: key, enabled: true, everyMs: 24 * H, next: NOW + H, nextApprox: false,
    last: { at: NOW - 2 * H, outcome, delivered: null, error: outcome === 'error' ? 'uscito 1' : null }, runs: [{ at: NOW - 2 * H, outcome }], tech: {} });
  const m = buildModel({ now: NOW, sources: {
    launchd: { ok: true, at: NOW, items: [mk('launchd:com.armonia.topics-db-snapshot', 'error'), mk('launchd:com.jarvis.devreap', 'ok'), mk('launchd:com.jarvis.manutenzione', 'error')] },
    github: { ok: true, at: NOW, items: [mk('gh:armonia/topics-app/e2e-nightly.yml', 'error')] },
  } });
  const ownKeys = m.own.map((c) => c.key).sort();
  assert.deepEqual(ownKeys, ['gh:armonia/topics-app/e2e-nightly.yml', 'launchd:com.armonia.topics-db-snapshot', 'launchd:com.jarvis.devreap']);
  // l'unico problema contato è quello di Jarvis
  assert.deepEqual([...m.needsYou, ...m.broken].map((c) => c.key), ['launchd:com.jarvis.manutenzione']);
  assert.equal(m.verdict.broken + m.verdict.needsYou, 1);
  assert.equal(m.verdict.own, 3);
  assert.ok(m.cards['launchd:com.armonia.topics-db-snapshot'].own, 'il pannello trova anche le voci a parte');
  assert.ok(!fromAutomations({ ...m, cards: { x: { key: 'x', own: true, level: 'te', reason: 'aspetta il tuo ok al passo «a»', title: 't' } } }).length);
  // pagina: sezione a parte, fuori da «Da sistemare»; col filtro Problemi sparisce
  const html = V.render(m, { filter: 'all', q: '' }, NOW);
  const own = html.slice(html.indexOf('data-area="computer-app"'));
  assert.ok(html.includes('data-area="computer-app"'));
  assert.match(own, /non contano tra i problemi/);
  assert.ok(!/data-fix="launchd:com\.armonia/.test(html), '«Risolvi tu» non propone le voci del computer');
  assert.ok(!V.render(m, { filter: 'pb', q: '' }, NOW).includes('data-area="computer-app"'));
  // diario: tipo «app», escluso dal filtro Problemi
  const items = journal({ model: m, now: NOW });
  assert.ok(items.some((e) => e.kind === 'app' && e.outcome === 'error'));
  const jh = P.journalHtml({ items }, { f: 'pb', q: '' }, NOW);
  assert.ok(!jh.includes('Copia') && !jh.includes('topics'), 'nessuna voce del computer tra i problemi');
});

test('Diario esterno: righe JSONL per giorno, righe rotte saltate, esito e link controllati', async () => {
  const { readDiary } = await import('../src/journal.mjs');
  const dd = path.join(dir, 'diario');
  fs.mkdirSync(dd, { recursive: true });
  const day = new Date(NOW).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dd, day + '.jsonl'), [
    JSON.stringify({ ts: NOW - 60000, source: 'task-sync', kind: 'creata', text: 'Card creata da Promemoria: prova', ref: 'r1', outcome: 'ok', link: 'javascript:alert(1)' }),
    '{rotta',
    JSON.stringify({ ts: new Date(NOW - 120000).toISOString(), source: 'task-sync', text: 'Promemoria giù, giro saltato', outcome: 'skipped' }),
    JSON.stringify({ ts: NOW - 1000, source: 'task-sync' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dd, '2001-01-01.jsonl'), JSON.stringify({ ts: 978307200000, source: 'x', text: 'vecchia' }) + '\n');
  const d = readDiary({ dir: dd, now: NOW, days: 7 });
  assert.deepEqual(d.map((x) => x.text).sort(), ['Card creata da Promemoria: prova', 'Promemoria giù, giro saltato']);
  assert.equal(d.find((x) => x.ref === 'r1').link, null, 'un link non http resta fuori');
  const items = journal({ diary: d, now: NOW });
  assert.equal(items[0].who, 'Task Topics ↔ Promemoria');
  assert.deepEqual(items.map((e) => e.outcome), ['ok', 'skipped']);
  assert.deepEqual(readDiary({ dir: path.join(dir, 'non-esiste'), now: NOW }), []);
});

test('Consumo per sessione: token e quota della settimana in parole, niente quando manca', () => {
  assert.equal(P.tokWords(143176016), '143,2 M token');
  assert.equal(P.tokWords(2000000), '2 M token');
  assert.equal(P.tokWords(22687), '23 k token');
  assert.equal(P.tokWords(0), '');
  assert.equal(P.useWords({ tokens: 957593, pct: 0.01 }), '958 k token, meno dello 0,1% della settimana');
  assert.equal(P.useWords({ tokens: 9412227, pct: 2.34 }), '9,4 M token, 2,3% della settimana');
  assert.equal(P.useWords({ tokens: 9412227, pct: null }), '9,4 M token');
  assert.equal(P.useWords(null), '');
});

test('Quota per sessione anche per Codex e Muse: token pesati come i progetti, poi la divisione', async () => {
  const { sessionUse } = await import('../src/session-use.mjs');
  const now = 10_000_000;
  const shareFor = (p, w) => ({ codex: w / 1e4, muse: w / 1e3 }[p] ?? null);
  // codex: [ts, delta, input, cached, output] → pesati = (input - cached)·1 + cached·0,1 + output·5
  const cx = sessionUse({ provider: 'codex', file: '/c', startedAt: 0 }, { codex: { files: new Map([['/c', { rows: [[now, 1000, 1000, 500, 100]] }]]) } }, { now, shareFor });
  assert.equal(cx.tokens, 1000);
  assert.equal(cx.pct, Math.round(((500 + 50 + 500) / 1e4) * 1000) / 1000);
  // muse: [ts, input, output, reasoning, riportati, wonder] → pesati = riportati
  const mu = sessionUse({ provider: 'muse', file: '/m', startedAt: 0 }, { muse: { files: new Map([['/m', { rows: [[now, 10, 10, 0, 200, false]] }]]) } }, { now, shareFor });
  assert.equal(mu.pct, 0.2);
  // senza conteggio riportato Muse non ha una quota stimabile
  const mu0 = sessionUse({ provider: 'muse', file: '/m', startedAt: 0 }, { muse: { files: new Map([['/m', { rows: [[now, 10, 10, 0, null, false]] }]]) } }, { now, shareFor });
  assert.equal(mu0.pct, null);
});

test('Titolo umano: niente chiavi di sessione, i messaggi fra sessioni hanno un nome', () => {
  assert.equal(P.humanTitle('[Inter-session message] sourceSession=agent:main:discord:channel:1551637216177123'), 'Messaggio da un\'altra sessione da Discord');
  assert.equal(P.humanTitle('Quadra UAT: causa e fix'), 'Quadra UAT: causa e fix');
  assert.equal(P.humanTitle('rifai il test sessionKey=agent:main:x:y'), 'rifai il test');
  assert.ok(P.humanTitle('a '.repeat(80)).length <= 90);
});

test('Demo: /api/hub-config dice demo, così ogni vista porta la fascia ESEMPIO; fuori dalla demo no', async () => {
  for (const demo of [true, false]) {
    const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] } }, { noLive: true, noQueue: true, ...(demo ? { demo: true } : {}) });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const c = await fetch(`http://127.0.0.1:${srv.address().port}/api/hub-config`).then((r) => r.json());
    srv.close();
    assert.equal(c.demo, demo);
  }
  assert.match(fs.readFileSync(path.join(root, 'public/pages.js'), 'utf8'), /ESEMPIO: questa è la demo/);
});

test('validateAttesa: link claude:// accettato (apre la sessione nell\'app), javascript: e data: rifiutati', () => {
  const base = { tipo: 'decisione', title: 'Una sessione aspetta una risposta' };
  assert.equal(validateAttesa({ ...base, link: 'claude://claude.ai/epitaxy/0e5a1d2c-1111-4222-8333-944455556666' }), null);
  for (const link of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', ' javascript:alert(1)', 'claude:alert(1)'])
    assert.match(validateAttesa({ ...base, link }) || '', /^link:/, `accettato: ${link}`);
});

test('Diario: la descrizione di un workflow entra solo se è italiana', async () => {
  const { journal } = await import('../src/journal.mjs');
  const now = Date.parse('2026-10-24T12:00:00+02:00');
  const run = (summary) => ({ at: now - 3600000, outcome: 'ok', agents: 2, durationMs: 120000, summary });
  const model = { cards: {}, workflows: { byName: [
    { name: 'verifica-inglese', runs: [run('Independent adversarial review of the Topics PRs before merge')] },
    { name: 'mappa-italiana', runs: [run('Mappa obiettivi, stato e risorse delle sessioni aperte, trova i conflitti e verificali')] }] } };
  const rows = journal({ model, now }).filter((r) => r.kind === 'workflow');
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows.map((r) => r.what).join(' | '), /Independent adversarial/);
  assert.match(rows.map((r) => r.what).join(' | '), /Mappa obiettivi/);
});
