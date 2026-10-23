import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findStalled, quotaFree, run } from '../scripts/muse-resume.mjs';

const resetsAt = Math.floor(Date.now() / 1000) + 5 * 86400;

function writeSession(root, dateParts, id, tailLines) {
  const dir = path.join(root, ...dateParts, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${tailLines.join('\n')}\n`);
}

function quotaLine(reason) {
  return JSON.stringify({ payload_type: 'runtime.session',
    payload: { kind: 'run', event: { kind: 'terminal', terminal: 'failed', reason } } });
}

const freeFetch = async () => ({ ok: true, status: 200, json: async () => ({ providers: [
  { id: 'muse', accounts: [{ id: 'm', label: 'me@example.com',
    quotas: [{ key: '5h', usedPct: 4, resetsAt }, { key: '7d', usedPct: 36, resetsAt }] }] },
] }) });
const blockedFetch = async () => ({ ok: true, status: 200, json: async () => ({ providers: [
  { id: 'muse', accounts: [{ id: 'm', label: 'me@example.com',
    quotas: [{ key: '5h', usedPct: 99, resetsAt }, { key: '7d', usedPct: 100, resetsAt }] }] },
] }) });

test('findStalled trova solo le ferme per quota', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  const dp = ['2026', '10', '12'];
  const r429 = 'model failed: API error 429: Subscription quota exhausted. resets at 2026-10-13T03:06:52Z. (rate_limit_error)';
  writeSession(root, dp, 'aaa', [quotaLine(r429)]);
  writeSession(root, dp, 'bbb', [quotaLine('boom: null pointer, niente quota qui')]);
  writeSession(root, dp, 'ccc', [JSON.stringify({ payload_type: 'runtime.session',
    payload: { kind: 'run', event: { kind: 'terminal', terminal: 'completed' } } })]);
  const found = findStalled(root).map((s) => s.id).sort();
  assert.deepEqual(found, ['aaa']);
});

test('quotaFree apre solo sotto 95/100', async () => {
  assert.equal((await quotaFree('http://x', freeFetch)).free, true);
  assert.equal((await quotaFree('http://x', blockedFetch)).free, false);
  assert.equal((await quotaFree('http://x', async () => { throw new Error('down'); })).free, false);
});

test('la ripresa scatta una volta e la seconda run resta muta', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  const r429 = 'API error 429: Subscription quota exhausted (rate_limit_error)';
  writeSession(root, ['2026', '10', '12'], 'sess-1', [quotaLine(r429)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-state-'));
  const sent = [];
  const opts = { root, trayUrl: 'http://x', fetchImpl: freeFetch,
    resumeFn: (sess, msg) => { sent.push([sess.id, msg]); return 'fake'; }, minIdleMs: 0, ownerAlive: () => true,
    stateFile: path.join(dir, 'resume.json'), logFile: path.join(dir, 'resume.log') };
  assert.deepEqual(await run(opts), ['mac:sess-1 via fake']);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /quota è tornata/);
  assert.deepEqual(await run(opts), [], 'second run is silent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'resume.json'), 'utf8'))['sess-1'], resetsAt * 1000);
});

test('senza quota libera nessuna ripresa', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  writeSession(root, ['2026', '10', '12'], 'sess-9', [quotaLine('429 quota exhausted')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-state-'));
  let called = 0;
  const out = await run({ root, trayUrl: 'http://x', fetchImpl: blockedFetch,
    resumeFn: () => { called += 1; return 'fake'; }, minIdleMs: 0, ownerAlive: () => true,
    stateFile: path.join(dir, 'resume.json'), logFile: path.join(dir, 'resume.log') });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test('una sessione senza processo vivo non si riprende', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  writeSession(root, ['2026', '10', '12'], 'sess-dead', [quotaLine('429 quota exhausted')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-state-'));
  const out = await run({ root, trayUrl: 'http://x', fetchImpl: freeFetch, minIdleMs: 0, ownerAlive: () => false,
    resumeFn: () => 'fake', stateFile: path.join(dir, 'resume.json'), logFile: path.join(dir, 'resume.log') });
  assert.deepEqual(out, []);
});
