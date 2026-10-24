import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const privateProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-private-'));
const privateProjectsFile = path.join(privateProjectsDir, 'private-projects.json');
fs.writeFileSync(privateProjectsFile, JSON.stringify(['progetto-alfa', 'progetto-beta', 'progetto.test']));
process.env.USAGE_HUB_PRIVATE_PROJECTS_FILE = privateProjectsFile;
const { route, isPrivate, classifyByRules } = await import('../src/route.mjs');
after(() => fs.rmSync(privateProjectsDir, { recursive: true, force: true }));

const DAY = 86400000;
const now = Date.now();
// Settimana a metà per tutti, ritmo in linea: il gate lascia passare ogni abbonamento.
const row = (provider, used = 40) => ({
  provider, account: `${provider}@x`, active: true, used, elapsedPct: 50, pace: used / 50,
  perDay: 10, resetsAt: now + 3.5 * DAY, fiveHour: null, status: 'ok',
});
const rows = [row('claude'), row('muse'), row('codex')];
const jev = (cls, tools) => async () => ({ cls, tools, by: 'jev' });
const never = async () => { throw new Error('Jev non doveva essere chiamato'); };

test('gusto va su Claude', async () => {
  const r = await route(rows, 'Rifai la hero più elegante', { classify: jev('taste', true) });
  assert.equal(r.provider, 'claude');
  assert.equal(r.gateClass, 'gusto');
});

test('meccanico con strumenti salta il gratis e va su Muse', async () => {
  const r = await route(rows, 'Trova i call site di gate()', { classify: jev('mechanical', true) });
  assert.equal(r.provider, 'muse');
});

test('meccanico senza strumenti va sui canali gratis', async () => {
  const r = await route(rows, 'Riassumi questo paragrafo', { classify: jev('mechanical', false) });
  assert.equal(r.provider, 'free');
});

test('Jev giù: decidono le regole', async () => {
  const r = await route(rows, 'Disegna il logo nuovo', { classify: async () => { throw new Error('timeout'); } });
  assert.equal(r.cls, 'taste');
  assert.match(r.by, /^rules/);
});

test('dati di persone vere: Jev non viene chiamato', async () => {
  for (const [task, project] of [['Scrivi a utente-a@example.com il riepilogo', ''], ['Pulisci la lista', 'progetto-alfa'], ['Richiama il +39 333 1234567', '']]) {
    const r = await route(rows, task, { project, classify: never });
    assert.match(r.by, /dati personali/);
    assert.notEqual(r.provider, 'free', `${task}: finito sul gratis`);
  }
});

test('dati di persone vere: Muse ammesso (Attilio 22/10)', async () => {
  const r = await route(rows, 'Pulisci la lista', { project: 'progetto-alfa', classify: never });
  assert.equal(r.provider, 'muse');
});

test('classe forzata vince sul decisore', async () => {
  const r = await route(rows, 'qualsiasi', { cls: 'taste', classify: never });
  assert.equal(r.provider, 'claude');
});

test('regole: gusto, meccanico e solo testo', () => {
  assert.equal(classifyByRules('Sistema il layout della home').cls, 'taste');
  assert.equal(classifyByRules('Aggiorna le dipendenze').cls, 'mechanical');
  assert.equal(classifyByRules('Riassumi il documento').tools, false);
  assert.equal(isPrivate('compito qualsiasi', 'claude-usage-hub'), false);
});

test('i nomi privati locali sono case-insensitive, letterali e separati dai progetti normali', () => {
  assert.equal(isPrivate('compito qualsiasi', 'PROGETTO-ALFA'), true);
  assert.equal(isPrivate('compito qualsiasi', 'progetto.beta'), false);
  assert.equal(isPrivate('compito qualsiasi', 'progettoXtest'), false);
  assert.equal(isPrivate('compito qualsiasi', 'progetto ordinario'), false);
});

test('catena: Groq al limite → risponde Jev', async () => {
  const { classifyByLLM, classifyByJev } = await import('../src/route.mjs');
  const groq429 = async () => ({ ok: false, status: 429 });
  const jevOk = async () => ({ ok: true, json: async () => ({ answers: { cls: { choice: 'taste' }, tools: { noul: 0.9 } } }) });
  await assert.rejects(classifyByLLM('x', { fetchImpl: groq429, key: 'k' }), /429/);
  const r = await classifyByJev('x', { fetchImpl: jevOk, key: 'k' });
  assert.equal(r.cls, 'taste');
});

const withUsed = (used) => [row('claude', used), row('muse'), row('codex')];

test('modello: gusto con margine → Opus; il modello è nella risposta', async () => {
  const r = await route(withUsed(40), 'Rifai la hero più elegante', { classify: jev('taste', true) });
  assert.equal(r.model, 'opus');
  assert.match(r.modelReason, /ritmo Claude 0,8/);
});

test('modello: gusto con Claude frenato (ritmo > 1) → Sonnet', async () => {
  const r = await route(withUsed(70), 'Rifai la hero più elegante', { classify: jev('taste', true), projectInfo: { name: 'x', priority: 'normale' } });
  assert.equal(r.go, true);
  assert.equal(r.model, 'sonnet');
  assert.match(r.modelReason, /frenato/);
});

test('modello: priorità alta con ritmo > 1 ma gate ok → Opus', async () => {
  const r = await route(withUsed(70), 'Rifai la hero più elegante', { classify: jev('taste', true), projectInfo: { name: 'zenocms', priority: 'alta' } });
  assert.equal(r.model, 'opus');
  assert.match(r.modelReason, /priorità alta/);
});

test('modello: meccanico resta com\'è, gli altri provider portano il loro nome', async () => {
  const m = await route(rows, 'Trova i call site di gate()', { classify: jev('mechanical', true) });
  assert.equal(m.model, 'muse');
  const f = await route(rows, 'Riassumi questo paragrafo', { classify: jev('mechanical', false) });
  assert.equal(f.model, 'free');
  const c = await route(rows, 'Trova i call site di gate()', { classify: jev('mechanical', true), cls: 'mechanical', projectInfo: null });
  assert.equal(c.model, 'muse');
});

// Haiku 5.5 (24/10, Attilio: «su Claude hai anche Haiku»): accetta l'effort e costa circa un ventesimo di Sonnet.
// Il meccanico che resta su Claude va su Haiku; Sonnet e Opus solo per gusto e giudizio.
test('modello: meccanico che resta su Claude → Haiku, effort medium con strumenti', async () => {
  const r = await route([row('claude')], 'Trova i call site di gate() e contali', { classify: jev('mechanical', true) });
  assert.deepEqual([r.provider, r.model, r.effort], ['claude', 'haiku', 'medium']);
  assert.match(r.modelReason, /Haiku/);
});

test('modello: testo privato senza strumenti su Claude → Haiku a effort low', async () => {
  const r = await route([row('claude')], 'Riassumi questa mail di mario@example.com', { classify: never });
  assert.deepEqual([r.provider, r.model, r.effort], ['claude', 'haiku', 'low']);
});

test('modello: il gusto non scende mai a Haiku', async () => {
  for (const used of [40, 70]) {
    const r = await route(withUsed(used), 'Rifai la hero più elegante', { classify: jev('taste', true), projectInfo: { name: 'x', priority: 'normale' } });
    assert.notEqual(r.model, 'haiku');
    assert.equal(r.effort, undefined);
  }
});
