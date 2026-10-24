import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueue, cancel, loadQueue, tick, recoverRunning, createNotifier, sendWhatsApp } from '../src/queue.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q-')), 'queue.json');
const open = async () => ({ go: true, provider: 'muse' });

test('accoda e legge, la priorità sconosciuta è rifiutata', () => {
  const f = tmp();
  const i = enqueue({ task: 'fai X', project: 'progetto-a' }, { file: f });
  assert.equal(loadQueue(f)[0].id, i.id);
  assert.equal(loadQueue(f)[0].status, 'queued');
  assert.throws(() => enqueue({ task: 'x', priority: 'urgentissima' }, { file: f }));
  assert.equal(cancel(i.id, f), true);
  assert.deepEqual(loadQueue(f), []);
});

test('priorità del progetto prima, poi anzianità; un solo lavoro per provider', async () => {
  const f = tmp();
  const a = enqueue({ task: 'vecchio normale', project: 'a' }, { file: f, now: 1 });
  const b = enqueue({ task: 'basso', project: 'b' }, { file: f, now: 2 });
  const c = enqueue({ task: 'alto recente', project: 'c' }, { file: f, now: 3 });
  const prio = { a: 'normale', b: 'bassa', c: 'alta' };
  const launched = [];
  await tick({ file: f, routeFn: open, projectOf: (n) => ({ priority: prio[n] }), launch: (it) => launched.push(it.id) });
  assert.deepEqual(launched, [c.id]); // tutti su muse: parte solo il primo in ordine
  const st = Object.fromEntries(loadQueue(f).map((i) => [i.id, i.status]));
  assert.deepEqual(st, { [a.id]: 'queued', [b.id]: 'queued', [c.id]: 'running' });
  // finché c gira, un altro giro non lancia nulla
  await tick({ file: f, routeFn: open, launch: (it) => launched.push(it.id) });
  assert.equal(launched.length, 1);
});

test('provider diversi partono insieme; frenato resta in coda con l\'ora stimata', async () => {
  const f = tmp();
  enqueue({ task: 'uno' }, { file: f, now: 1 });
  enqueue({ task: 'due' }, { file: f, now: 2 });
  enqueue({ task: 'tre' }, { file: f, now: 3 });
  const by = { uno: { go: true, provider: 'muse' }, due: { go: true, provider: 'codex' }, tre: { go: false, waitUntil: 99 } };
  const launched = [];
  await tick({ file: f, routeFn: async (i) => by[i.task], launch: (it) => launched.push(it.task) });
  assert.deepEqual(launched, ['uno', 'due']);
  assert.equal(loadQueue(f).find((i) => i.task === 'tre').waitUntil, 99);
});

test('fine lavoro: done, failed, exit 10 torna in coda; riavvio recupera i running', async () => {
  const f = tmp();
  for (const t of ['ok', 'ko', 'race']) enqueue({ task: t }, { file: f });
  const route3 = { ok: 'muse', ko: 'codex', race: 'claude' };
  const codes = { ok: 0, ko: 1, race: 10 };
  const notes = [];
  await tick({ file: f, routeFn: async (i) => ({ go: true, provider: route3[i.task] }), notify: (l) => notes.push(l), launch: (it, done) => done(codes[it.task]) });
  const st = Object.fromEntries(loadQueue(f).map((i) => [i.task, i.status]));
  assert.deepEqual(st, { ok: 'done', ko: 'failed', race: 'queued' });
  assert.deepEqual(notes.filter((n) => /^(parte|finito|fallito)/.test(n)).map((n) => n.split(' ')[0]), ['fallito']);
  await tick({ file: f, routeFn: open, launch: () => {} }); // race riparte e resta running
  assert.equal(recoverRunning(f), 1);
  assert.equal(loadQueue(f).find((i) => i.task === 'race').status, 'queued');
});

test('avvisi della coda: nel diario, mai su WhatsApp', () => {
  const sent = [], diary = [];
  const n = createNotifier({ send: (m) => sent.push(m), diary: (r) => diary.push(r) });
  n.push('in coda abc123 (p): uno'); n.push('fallito (exit 1) abc123: due');
  assert.equal(n.flush(), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(diary.map((r) => [r.source, r.outcome]), [['delega', 'ok'], ['delega', 'error']]);
});

test('sendWhatsApp senza destinatario configurato non manda niente e non fallisce', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'q-home-')); // niente notify.json dentro
  const prevHome = process.env.HOME, prevTo = process.env.USAGE_HUB_WHATSAPP_TO;
  process.env.HOME = home; delete process.env.USAGE_HUB_WHATSAPP_TO;
  try {
    assert.equal(sendWhatsApp('prova'), undefined);
  } finally {
    process.env.HOME = prevHome;
    if (prevTo !== undefined) process.env.USAGE_HUB_WHATSAPP_TO = prevTo;
  }
});

test('lavoro notturno: di giorno resta in coda, fra l\'1 e le 7 parte', async () => {
  const f = tmp();
  const day = new Date(2026, 9, 24, 15, 0).getTime(); const night = new Date(2026, 9, 25, 2, 0).getTime();
  enqueue({ task: 'card di notte', night: true, ref: 'card:b/1' }, { file: f, now: 1 });
  enqueue({ task: 'normale' }, { file: f, now: 2 });
  const launched = [];
  await tick({ file: f, now: day, routeFn: async (i) => ({ go: true, provider: i.night ? 'muse' : 'codex' }), launch: (it) => launched.push(it.task) });
  assert.deepEqual(launched, ['normale']);
  await tick({ file: f, now: night, routeFn: async () => ({ go: true, provider: 'muse' }), launch: (it) => launched.push(it.task) });
  assert.deepEqual(launched, ['normale', 'card di notte']);
});
