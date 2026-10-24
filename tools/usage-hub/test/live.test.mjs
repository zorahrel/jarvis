import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSummary, saveProjectSetting, cleanName, explainProjects } from '../src/live.mjs';
import { buildPace, gate } from '../src/pacing.mjs';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const D = 86400000;
const report = {
  projects: [{ name: 'zenocms', weekPct: 5.3 }, { name: 'openclaw/sub:<<<END_OPENCLAW_INTERNAL_CONTEXT>>>', weekPct: 0.9 }, { name: 'openclaw/sub:logo v3.10', weekPct: 1.1 }],
  codex: { projects: [{ name: 'zenocms', weekPct: 7.45 }] },
  muse: { projects: [{ name: 'zenocms', weekPct: 16.2 }, { name: 'pop-demo', weekPct: 3 }] },
};

test('somma per progetto su Claude, Codex e Muse e nomi puliti', () => {
  const rows = projectSummary(report, {});
  const z = rows.find((r) => r.name === 'zenocms');
  assert.deepEqual([z.claude, z.codex, z.muse, z.total], [5.3, 7.5, 16.2, 29]);
  assert.equal(rows.find((r) => r.name === 'openclaw/sottoagenti').claude, 2);
  assert.equal(cleanName('openclaw/sub:x'), 'openclaw/sottoagenti');
});

test('i progetti con budget vanno in cima, anche fermi', () => {
  const rows = projectSummary(report, { PrinceOfPersia: { budgetPct: 10, priority: 'alta' } });
  assert.deepEqual([rows[0].name, rows[0].budgetPct, rows[0].priority, rows[0].total], ['PrinceOfPersia', 10, 'alta', 0]);
});

test('saveProjectSetting scrive senza perdere gli altri campi', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), 'budgets.json');
  fs.writeFileSync(file, JSON.stringify({ projects: { PoP: { budgetPct: 10, match: ['-pop'], enforce: true } }, muse: { budgetPct: 80 } }));
  saveProjectSetting('PoP', { priority: 'alta' }, file);
  saveProjectSetting('zenocms', { budgetPct: 15 }, file);
  saveProjectSetting('PoP', { budgetPct: null }, file);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc.projects.PoP, { match: ['-pop'], enforce: true, priority: 'alta' });
  assert.deepEqual(doc.projects.zenocms, { match: ['zenocms'], budgetPct: 15 });
  assert.equal(doc.muse.budgetPct, 80);
  assert.throws(() => saveProjectSetting('x', { priority: 'urgente' }, file));
});

const ov = (used, resetIn) => ({ providers: [{ id: 'claude', accounts: [{ label: 'z', quotas: [{ key: '7d', usedPct: used, resetsAt: (NOW + resetIn) / 1000 }] }] }] });

test('priorità: la bassa si ferma prima, l\'alta corre di più', () => {
  // 45% al 40% di settimana: ritmo 1,125
  const rows = buildPace(ov(45, 4.2 * D), { now: NOW });
  const g = (priority) => gate(rows, 'batch', { now: NOW, skip: ['free', 'muse', 'codex'], project: { name: 'p', priority, total: 1, budgetPct: null } }).go;
  assert.deepEqual([g('alta'), g('normale'), g('bassa')], [true, false, false]);
  const m = (priority) => gate(rows, 'massivo', { now: NOW, skip: ['free', 'muse', 'codex'], project: { name: 'p', priority, total: 1, budgetPct: null } }).go;
  assert.deepEqual([m('normale'), m('bassa')], [true, false]);
});

test('budget di progetto sforato ferma tutto tranne l\'interattivo', () => {
  const rows = buildPace(ov(10, 5 * D), { now: NOW });
  const project = { name: 'PoP', priority: 'alta', claude: 12, muse: 30, total: 42, budgetPct: 10 };
  const g = gate(rows, 'gusto', { now: NOW, project });
  assert.equal(g.go, false);
  assert.match(g.reason, /budget 10%/);
  assert.equal(gate(rows, 'interattivo', { now: NOW, project }).go, true);
  // Muse alto ma Claude sotto budget: non si ferma (unità diverse)
  assert.equal(gate(rows, 'gusto', { now: NOW, project: { ...project, claude: 3 } }).go, true);
});

test('titolo e descrizione dalla mappa etichette; chiave ignota resta grezza', async () => {
  const { projectSummary } = await import('../src/live.mjs');
  const rep = { projects: [{ name: 'nightly', weekPct: 5 }, { name: 'boh', weekPct: 4 }] };
  const r = projectSummary(rep, {}, { labels: { nightly: { label: 'PR notturne', what: 'cose' } } });
  assert.deepEqual([r[0].title, r[0].what, r[1].title, r[1].what], ['PR notturne', 'cose', 'boh', null]);
});

test('ogni progetto porta la sua cartella; le cartelle temporanee sorelle diventano una riga sola', () => {
  const home = '/Users/x';
  const ag = (n, model) => ({ count: n, models: [{ provider: 'muse', model, n }], opus: 0, opusMs: 0, list: [{ title: '', model, provider: 'muse' }] });
  const ps = [
    { name: 'hub', title: 'Usage hub', what: 'Questo hub', claude: 2, codex: 0, muse: 0, total: 2, budgetPct: null, agents: null },
    { name: 'jarvis', title: 'jarvis', what: null, claude: 1, codex: 0, muse: 0, total: 1, budgetPct: null, agents: null },
    ...['A-1', 'B-2', 'C-3'].map((n, i) => ({ name: n, title: n, what: null, claude: 0, codex: i, muse: 1, total: i + 1, budgetPct: null, agents: i ? null : ag(1, 'Muse'), state: 'attivo', lastSeen: { at: i, provider: 'muse' } })),
    { name: 'D-4', title: 'D-4', what: null, claude: 0, codex: 0, muse: 0, total: 0, budgetPct: null, agents: null },
  ];
  const dirs = { hub: '/Users/x/Projects/hub', jarvis: '/Users/x/.claude/jarvis', 'A-1': '/private/tmp/zgen/pair/A-1', 'B-2': '/private/tmp/zgen/pair/B-2', 'C-3': '/private/tmp/zgen/pair/C-3', 'D-4': '/private/tmp/altro/D-4' };
  const out = explainProjects(ps, (p) => dirs[p.name], { home });
  assert.deepEqual(out.map((p) => p.name), ['hub', 'jarvis', 'tmp:/tmp/zgen', 'D-4']);
  assert.equal(out[0].what, 'Questo hub', 'una descrizione scritta a mano resta');
  assert.equal(out[1].what, 'cartella ~/.claude/jarvis');
  const g = out[2];
  assert.equal(g.title, '3 cartelle temporanee');
  assert.equal(g.what, 'in /tmp/zgen/pair: A-1, B-2, C-3');
  assert.deepEqual([g.codex, g.muse, g.total, g.agents.count, g.lastSeen.at], [3, 3, 6, 1, 2]);
  assert.equal(g.agents.list[0].title, 'A-1', 'l\'agente dice in quale cartella gira');
  assert.equal(out[3].what, 'cartella /tmp/altro/D-4', 'una cartella temporanea isolata resta da sola');
});

test('cartelle temporanee su più livelli: una riga per la cima di /tmp, un sottogruppo per cartella madre', () => {
  const ps = ['a', 'b', 'c', 'd'].map((n) => ({ name: n, title: n, what: null, claude: 0, codex: 1, muse: 0, total: 1, budgetPct: null, agents: null }));
  const dirs = { a: '/private/tmp/zgen/vg/r2/pair/a', b: '/private/tmp/zgen/vg/r2/pair/b', c: '/private/tmp/zgen/vg/r2/pair/c', d: '/private/tmp/zgen/vg/c0/pair/d' };
  const [g] = explainProjects(ps, (p) => dirs[p.name], { home: '/Users/x' });
  assert.equal(g.title, '4 cartelle temporanee');
  assert.equal(g.what, 'in /tmp/zgen: 3 in vg/r2/pair, 1 in vg/c0/pair');
  assert.deepEqual(g.subgroups.map((x) => [x.path, x.members, x.codex]), [['vg/r2/pair', ['a', 'b', 'c'], 3], ['vg/c0/pair', ['d'], 1]]);
});

test('gruppi temporanei: /tmp e /private/tmp sono la stessa cartella, chi ha una priorità resta fuori, mkdtemp per prefisso', () => {
  const mk = (name, extra = {}) => ({ name, title: name, what: null, claude: 0, codex: 1, muse: 0, total: 1, budgetPct: null, priority: 'normale', agents: null, ...extra });
  const dirs = { a: '/tmp/z/p/a', b: '/private/tmp/z/p/b', c: '/private/tmp/z/p/c', d: '/tmp/z/p/d', e: '/private/tmp/judge-a8Xk2p', f: '/tmp/judge-Q93kd0', g: '/private/tmp/judge-zz81LM' };
  const out = explainProjects([mk('a'), mk('b'), mk('c'), mk('d', { priority: 'alta' }), mk('e'), mk('f'), mk('g')], (p) => dirs[p.name], { home: '/Users/x' });
  const z = out.find((p) => p.name === 'tmp:/tmp/z');
  assert.deepEqual(z.members, ['a', 'b', 'c'], 'Codex (/tmp) e Claude (/private/tmp) nello stesso gruppo');
  assert.ok(out.some((p) => p.name === 'd' && p.priority === 'alta'), 'la priorità alta resta visibile');
  const j = out.find((p) => p.name === 'tmp:/tmp/judge-*');
  assert.deepEqual([j.members, j.subgroups.map((x) => x.path)], [['e', 'f', 'g'], ['.']]);
});

test('openclawLabel: i bucket di OpenClaw si leggono come Jarvis · canale', async () => {
  const { openclawLabel, labelFor } = await import('../src/live.mjs');
  assert.equal(openclawLabel('openclaw/whatsapp-diretta').label, 'Jarvis · WhatsApp');
  assert.equal(openclawLabel('openclaw/discord:#prova').label, 'Jarvis · Discord #prova');
  assert.equal(openclawLabel('openclaw/wa:whatsapp:g-cliente-20-prova-hr').label, 'Jarvis · cliente 20 prova hr');
  assert.equal(openclawLabel('openclaw/sottoagenti'), null);
  assert.equal(openclawLabel('jarvis'), null);
  assert.equal(labelFor('openclaw/altro').label, 'Jarvis · altro');
});

test('displayNames: un worktree prende il nome del repo, una cartella temporanea il lavoro, mai la cartella grezza', async () => {
  const { displayNames } = await import('../src/live.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-')); const repo = path.join(root, 'topics-app'); const wt = path.join(root, 'altrove', 'gc-t9-002a07');
  fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${repo}/.git/worktrees/gc-t9-002a07\n`);
  const out = displayNames([
    { name: 'topics-app', title: 'Topics', _abs: repo },
    { name: 'gc-t9-002a07', title: 'gc-t9-002a07', _abs: wt },
    { name: 'wonderful-brattain-df6b9b', title: 'wonderful-brattain-df6b9b', _abs: `${root}/topics-app/.claude/worktrees/wonderful-brattain-df6b9b` },
    { name: 'scratch-2026-10-22-30b95d', title: 'Prova del 22/10', what: 'Cartella temporanea di una sessione Claude', agents: { list: [{ work: 'Topics: token giusti', startedAt: 2 }, { work: 'Regia sessioni', startedAt: 1 }] } },
    { name: 'jarvis', title: 'jarvis', _abs: '/x/jarvis' },
  ]);
  assert.deepEqual(out.map((p) => p.display), ['Topics', 'Topics', 'Topics', 'Regia sessioni', 'jarvis']);
});
