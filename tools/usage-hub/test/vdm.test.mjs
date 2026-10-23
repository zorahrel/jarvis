import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeProxy, fetchProxy, createProxyFeed } from '../src/vdm.mjs';

const rec = (ts, repo, out = 100) => ({ ts, repo, inputTokens: 1, outputTokens: out, cacheReadTokens: 0, cacheCreationTokens: 0 });

test('attributes by cwd, counts blind requests and flags the openclaw root', () => {
  const r = attributeProxy({
    records: [rec(10, '/w/app'), rec(11, '/w/app'), rec(12, '/w/oc'), rec(13, '_sys_abc'), rec(1, '/w/old')],
    sessions: { active: [{ cwd: '_sys_abc' }], recent: [{ cwd: '/w/app' }] },
  }, { sinceMs: 5, openclawRoot: '/w/oc' });
  assert.equal(r.requests, 4);
  assert.equal(r.withoutCwd, 1);
  assert.equal(r.blindSessions, 1);
  assert.deepEqual(r.coverage, { from: 10, to: 13 });
  assert.equal(r.projects[0].name, 'app');
  assert.equal(r.projects[0].requests, 2);
  assert.equal(r.projects.find((p) => p.name === 'oc').needsLogs, true);
  assert.match(r.note, /session logs/);
});

test('full cwd coverage says so', () => {
  const r = attributeProxy({ records: [rec(1, '/w/a')] });
  assert.match(r.note, /sees the cwd for all/);
});

test('unreachable proxy degrades to a note', async () => {
  const r = await fetchProxy('http://x', async () => { throw new Error('down'); });
  assert.equal(r.available, false);
  assert.match(r.note, /logs only/);
});

test('fetchProxy reads both endpoints', async () => {
  const f = async (u) => ({ ok: true, json: async () => (u.endsWith('token-usage') ? [rec(1, '/w/a')] : { active: [] }) });
  const r = await fetchProxy('http://x', f);
  assert.equal(r.available, true);
  assert.equal(r.projects.length, 1);
});

test('fetchProxy con feed: chiede solo dal penultimo minuto e non conta due volte i record ripetuti', async () => {
  const all = [rec(1000, '/w/a'), rec(200000, '/w/a')];
  const asked = [];
  const f = async (u) => {
    asked.push(u);
    const since = Number(new URL(u).searchParams.get('since') || 0);
    return { ok: true, json: async () => (u.includes('token-usage') ? all.filter((r) => r.ts >= since) : { active: [] }) };
  };
  const feed = createProxyFeed();
  const a = await fetchProxy('http://x', f, { feed, sinceMs: 1 });
  all.push(rec(230000, '/w/b'));
  const b = await fetchProxy('http://x', f, { feed, sinceMs: 1 });
  assert.equal(a.requests, 2);
  assert.equal(b.requests, 3);
  assert.match(asked[2], /since=140000$/);
});
