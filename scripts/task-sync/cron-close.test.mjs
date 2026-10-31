// Prova di cron-close con cron e Topics finti, board di prova. node --test scripts/task-sync/cron-close.test.mjs
// CRON_CLOSE_MODULE punta a una copia mutata (vedi cron-close-mutant.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { closeRound, decide, refsOf } = await import(process.env.CRON_CLOSE_MODULE ? pathToFileURL(process.env.CRON_CLOSE_MODULE).href : './cron-close.mjs');
const H = 3600e3, T0 = Date.parse('2026-10-26T08:00:00Z'); // 09:00 a Roma, l'ora del cron finto
const JOB = 'aaaaaaaa-1111-2222-3333-444444444444';

function world({ cards, receipts = [], jobs = [{ id: JOB, at: new Date(T0).toISOString() }] }) {
  const writes = [];
  const topics = {
    async openCards() { return cards.map((c) => ({ board: 'prova-test01', text: '', cls: 'open', ...c })); },
    async comment(b, id, t) { writes.push(['comment', id, t]); },
    async patch(b, id, p) { writes.push(['patch', id, p]); },
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cron-close-')), 'watch.json');
  const run = (now) => closeRound({ topics, read: () => ({ jobs, receipts }), now, file, log: (l) => writes.push(['log', l]), notify: (t) => writes.push(['wa', t]) });
  return { writes, run, file };
}
const rec = (o) => ({ job_id: JOB, status: 'ok', started_at_ms: T0 + 20e3, delivered: true, ...o });

test('refsOf trova «cron <id8>» nel titolo o nella descrizione', () => {
  assert.deepEqual(refsOf({ title: 'Patto', text: 'Cron: AAAAAAAA e cron bbbbbbbb' }), ['aaaaaaaa', 'bbbbbbbb']);
  assert.deepEqual(refsOf({ title: 'niente', text: 'crono 12345678' }), []);
});

test('run ok e consegnato: la card si chiude con la prova', async () => {
  const w = world({ cards: [{ id: 'c1', title: 'Promemoria Patto', text: 'Cron: aaaaaaaa' }], receipts: [rec()] });
  await w.run(T0 + 5 * 60e3);
  assert.ok(w.writes.some((x) => x[0] === 'patch' && x[1] === 'c1' && x[2].status === 'done'));
  assert.match(w.writes.find((x) => x[0] === 'comment')[2], /^Prova: cron aaaaaaaa: run ok e consegnato/);
});

test('run ok ma non consegnato: la card resta aperta', async () => {
  const w = world({ cards: [{ id: 'c1', title: 'x', text: 'cron aaaaaaaa' }], receipts: [rec({ delivered: false })] });
  await w.run(T0 + 5 * 60e3);
  assert.equal(w.writes.filter((x) => x[0] === 'patch').length, 0);
});

test('un run di ieri non chiude la card di oggi', async () => {
  const w = world({ cards: [{ id: 'c1', title: 'x', text: 'cron aaaaaaaa' }], receipts: [rec({ started_at_ms: T0 - 24 * H })] });
  await w.run(T0 + 5 * 60e3);
  assert.equal(w.writes.filter((x) => x[0] === 'patch').length, 0);
});

test('ora passata senza run: una riga di avviso, una volta sola', async () => {
  const w = world({ cards: [{ id: 'c1', title: 'Promemoria Patto', text: 'cron aaaaaaaa' }] });
  await w.run(T0 + 5 * 60e3);
  assert.equal(w.writes.filter((x) => x[0] === 'log').length, 0, 'dentro la tolleranza non avvisa');
  await w.run(T0 + 2 * H);
  await w.run(T0 + 3 * H);
  const logs = w.writes.filter((x) => x[0] === 'log');
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /cron aaaaaaaa doveva girare alle 09:00 e non ha un run consegnato/);
  // l'avviso arriva a qualcuno: commento sulla card + WhatsApp, una volta sola
  assert.equal(w.writes.filter((x) => x[0] === 'comment' && /^⏰ cron aaaaaaaa doveva girare/.test(x[2])).length, 1);
  assert.equal(w.writes.filter((x) => x[0] === 'wa' && /cron aaaaaaaa doveva girare/.test(x[1])).length, 1);
  assert.equal(w.writes.filter((x) => x[0] === 'patch').length, 0);
});

test('cron sparito: avviso, mai chiusura', async () => {
  const w = world({ cards: [{ id: 'c1', title: 'x', text: 'cron bbbbbbbb' }], jobs: [] });
  await w.run(T0 + 2 * H);
  assert.match(w.writes.find((x) => x[0] === 'log')[1], /cron bbbbbbbb non esiste più/);
  assert.equal(w.writes.filter((x) => x[0] === 'patch').length, 0);
});

test('due cron sulla card: si chiude solo quando hanno girato tutti e due', async () => {
  const J2 = 'bbbbbbbb-1111-2222-3333-444444444444';
  const jobs = [{ id: JOB, at: new Date(T0).toISOString() }, { id: J2, at: new Date(T0).toISOString() }];
  const w = world({ cards: [{ id: 'c1', title: 'x', text: 'cron aaaaaaaa cron bbbbbbbb' }], jobs, receipts: [rec()] });
  await w.run(T0 + 5 * 60e3);
  assert.equal(w.writes.filter((x) => x[0] === 'patch').length, 0);
});

test('card già chiusa o senza riferimento: non si tocca', async () => {
  const w = world({ cards: [{ id: 'c1', title: 'x', text: 'cron aaaaaaaa', cls: 'done' }, { id: 'c2', title: 'libera', text: '' }], receipts: [rec()] });
  await w.run(T0 + 5 * 60e3);
  assert.equal(w.writes.length, 0);
});

test('cron ricorrente: il run della settimana scorsa non vale, quello nuovo sì', async () => {
  const jobs = [{ id: JOB, at: null, nextRunAtMs: T0 }];
  const w = world({ cards: [{ id: 'c1', title: 'x', text: 'cron aaaaaaaa' }], jobs, receipts: [rec({ started_at_ms: T0 - 7 * 24 * H })] });
  await w.run(T0 - H);
  assert.equal(w.writes.filter((x) => x[0] === 'patch').length, 0);
  await w.run(T0 + 5 * 60e3); // il job non ha ancora girato
  assert.equal(w.writes.filter((x) => x[0] === 'patch').length, 0);
});

test('cron «at» cancellato dopo il run: la ricevuta basta, se l\'ora attesa era già fissata', async () => {
  const w = world({ cards: [{ id: 'c1', title: 'x', text: 'cron aaaaaaaa' }] });
  await w.run(T0 - H); // prima vista: fissa l'ora
  const topics = { async openCards() { return [{ id: 'c1', board: 'prova-test01', title: 'x', text: 'cron aaaaaaaa', cls: 'open' }]; }, async comment() { w.writes.push(['comment']); }, async patch(b, id, p) { w.writes.push(['patch', id, p]); } };
  await closeRound({ topics, read: () => ({ jobs: [], receipts: [rec()] }), now: T0 + 10 * 60e3, file: w.file, log: () => {} });
  assert.ok(w.writes.some((x) => x[0] === 'patch' && x[2].status === 'done'));
});

test('readCron: la ricevuta «started» non basta, vale il registro dei run del gateway', async () => {
  const { readCron } = await import(process.env.CRON_CLOSE_MODULE ? pathToFileURL(process.env.CRON_CLOSE_MODULE).href : './cron-close.mjs');
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cron-db-')), 'o.sqlite');
  const { execFileSync } = await import('node:child_process');
  const now = Date.now(), J1 = 'aaaaaaaa-0000', J2 = 'bbbbbbbb-0000';
  execFileSync('sqlite3', [db, `create table cron_jobs(job_id,job_json,state_json); create table cron_run_receipts(job_id,status,started_at_ms,delivery_attempt_state);
    insert into cron_run_receipts values ('${J1}','ok',${now},'started'),('${J2}','ok',${now},'started');`]);
  process.env.CRON_CLOSE_DB = db;
  const mod = await import(`${process.env.CRON_CLOSE_MODULE ? pathToFileURL(process.env.CRON_CLOSE_MODULE).href : './cron-close.mjs'}?db`);
  // il modulo legge DB all'import: ricarica con la variabile impostata
  const { receipts } = mod.readCron(['aaaaaaaa', 'bbbbbbbb'], (id) => (id === J1 ? [now + 5e3] : [now - 3600e3]));
  assert.equal(receipts.find((r) => r.job_id === J1).delivered, true);
  assert.equal(receipts.find((r) => r.job_id === J2).delivered, false, 'tentata ma soppressa: non è consegnata');
});
