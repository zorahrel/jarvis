import '../test-support/isolate-tmp.mjs';
// Quota per sessione: tracker Claude senza doppioni, sottoagenti dei workflow letti, giro intero, quote piccole
// non arrotondate a zero, divisione uguale ai progetti (shareFromReport) e la barra dell'hub vivo che sa cadere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeTracker } from '../src/usage.mjs';
import { sessionUse, shareFromReport, checkSessionUse } from '../src/session-use.mjs';

const MIN = 60000;
const line = (ts, id, u = { input_tokens: 100, output_tokens: 10 }) => JSON.stringify({ timestamp: new Date(ts).toISOString(), cwd: '/w/p', message: { id, usage: u } });

test('tracker Claude: una riga per messaggio anche se Claude Code la ripete per ogni blocco', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), now = Date.now();
  fs.mkdirSync(path.join(root, '-w-p'));
  fs.writeFileSync(path.join(root, '-w-p', 's.jsonl'), [line(now - MIN, 'msg_1'), line(now - MIN, 'msg_1'), line(now - MIN, 'msg_1'), line(now, 'msg_2')].join('\n') + '\n');
  const t = createClaudeTracker(); t.update({ root, sinceMs: now - 86400000, now });
  assert.equal(t.files.get(path.join(root, '-w-p', 's.jsonl')).rows.length, 2);
  // e la lettura incrementale non riconta un id già visto
  fs.appendFileSync(path.join(root, '-w-p', 's.jsonl'), line(now, 'msg_2') + '\n');
  t.update({ root, sinceMs: now - 86400000, now });
  assert.equal(t.files.get(path.join(root, '-w-p', 's.jsonl')).rows.length, 2);
});

test('tracker Claude: legge i sottoagenti dei workflow (subagents/workflows/<wf>/)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), now = Date.now();
  const wf = path.join(root, '-w-p', 'sess1', 'subagents', 'workflows', 'review');
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(path.join(root, '-w-p', 'sess1.jsonl'), line(now, 'm0') + '\n');
  fs.writeFileSync(path.join(wf, 'agent-abc.jsonl'), line(now, 'm1') + '\n');
  const t = createClaudeTracker(); t.update({ root, sinceMs: now - 86400000, now });
  assert.ok(t.files.has(path.join(wf, 'agent-abc.jsonl')));
});

test('sessionUse: il giro parte dalle righe del file, non dall\'inizio stimato sulla coda', () => {
  const now = Date.now(), rows = [];
  for (let i = 0; i < 120; i += 5) rows.push([now - (120 - i) * MIN, '/w/p', 100, 10, 0, 0]);   // due ore senza buchi
  const trackers = { claude: { files: new Map([['f', { rows }]]) } };
  const u = sessionUse({ provider: 'claude', file: 'f', startedAt: now - 10 * MIN }, trackers, { now, weekShare: () => 1 });
  assert.equal(u.startedAt, now - 120 * MIN);
  assert.equal(u.tokens, rows.length * 110);
});

test('sessionUse: una sessione piccola non arrotonda la quota a zero', () => {
  const now = Date.now(), trackers = { claude: { files: new Map([['f', { rows: [[now, '/w/p', 10, 1, 0, 0]] }]]) } };
  const u = sessionUse({ provider: 'claude', file: 'f', startedAt: now - MIN }, trackers, { now, weekShare: (w) => w / 1e7 });
  assert.ok(u.pct > 0, `pct ${u.pct}`);
});

test('shareFromReport: stessa divisione dei progetti per Claude, Codex e Muse', () => {
  const r = { projects: [{ tokens: 600 }, { tokens: 400 }], account: { weekPct: 50 },
    codex: { projects: [{ tokens: 1000 }], quota: { weekPct: 20 } }, muse: { projects: [{ tokens: 200, unit: 'tokens' }], quota: { weekPct: 10 } } };
  assert.equal(shareFromReport(r, 'claude', 100), 5);
  assert.equal(shareFromReport(r, 'codex', 500), 10);
  assert.equal(shareFromReport(r, 'muse', 100), 5);
  assert.equal(shareFromReport({ ...r, muse: { projects: [{ tokens: 3, unit: 'turns' }], quota: { weekPct: 10 } } }, 'muse', 1), null);
  assert.equal(shareFromReport(r, 'claude', 0), null);
});

test('checkSessionUse: verde sul caso buono, rosso senza consumo, senza quota o con un peso ×100', () => {
  const now = Date.now(), old = now - 60 * MIN;
  const a = (provider, use) => ({ provider, kind: 'sessione', file: 'f', startedAt: old, title: 't', use });
  const projects = (list) => [{ agents: { list } }];
  const pace = [{ provider: 'claude', used: 40 }, { provider: 'codex', used: 30 }];
  const good = [a('claude', { tokens: 10, pct: 2 }), a('claude', { tokens: 5, pct: 1 }), a('codex', { tokens: 9, pct: 3 })];
  assert.deepEqual(checkSessionUse(projects(good), pace, { now }).fail, []);
  assert.equal(checkSessionUse(projects([a('claude', null), a('claude', null)]), pace, { now }).fail.length, 1);
  assert.equal(checkSessionUse(projects([a('codex', { tokens: 9, pct: null })]), pace, { now }).fail.length, 1);
  assert.equal(checkSessionUse(projects([a('codex', { tokens: 9, pct: 300 })]), pace, { now }).fail.length, 1);
  // una sessione appena partita non è ancora nel tracker: non conta
  assert.deepEqual(checkSessionUse(projects([{ ...a('claude', null), startedAt: now - MIN }]), pace, { now }).fail, []);
});
