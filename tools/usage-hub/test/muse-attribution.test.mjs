import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../src/projects.mjs';
import { createServer } from '../src/server.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const claudeReset = Date.UTC(2026, 9, 20, 12) / 1000;
const museReset = Date.UTC(2026, 9, 17, 12) / 1000;
const overview = { providers: [
  { id: 'claude', accounts: [{ id: 'claude', active: true, label: 'Claude', quotas: [
    { key: '7d', usedPct: 40, resetsAt: claudeReset },
  ] }] },
  { id: 'muse', accounts: [{ id: 'muse', active: true, label: 'Muse', quotas: [
    { key: '7d', usedPct: 40, resetsAt: museReset },
  ] }] },
] };
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => overview });

function fixtureRoot(name) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-muse-fixture-'));
  const root = path.join(temp, 'sessions');
  fs.cpSync(path.join(TEST_DIR, 'fixtures', 'muse', name), root, { recursive: true });
  return { temp, root };
}

function config(extra = {}) {
  return { quotaSource: { url: 'http://fixture' }, muse: true, groups: [], ...extra };
}

test('Muse usa la propria settimana, applica i match budget e attribuisce token per progetto', async () => {
  const { temp, root: museRoot } = fixtureRoot('tokenized');
  const report = await buildReport(config({ budgets: { Alpha: { match: ['alpha-app'] } } }), {
    fetchImpl: fakeFetch,
    root: path.join(temp, 'claude'),
    museRoot,
  });

  assert.equal(report.muse.sinceMs, Date.UTC(2026, 9, 10, 12));
  assert.equal(report.sinceMs, Date.UTC(2026, 9, 13, 12));
  assert.equal(report.muse.unit, 'tokens');
  assert.equal(report.muse.projects.length, 2);
  const alpha = report.muse.projects.find((p) => p.name === 'Alpha');
  const fallback = report.muse.projects.find((p) => p.name === 'uncategorized-app');
  assert.deepEqual([alpha.requests, alpha.tokens, alpha.weight, alpha.share, alpha.weekPct], [2, 200, 200, 0.5, 20]);
  assert.deepEqual([fallback.requests, fallback.tokens, fallback.weight, fallback.share], [1, 200, 200, 0.5]);
});

test('Muse usa i model turn come unità solo quando mancano i token', async () => {
  const { temp, root: museRoot } = fixtureRoot('turns');
  const report = await buildReport(config(), { fetchImpl: fakeFetch, root: path.join(temp, 'claude'), museRoot });
  assert.equal(report.muse.unit, 'turns');
  assert.deepEqual(report.muse.projects.map(({ name, requests, tokens, weight, unit, share }) => ({ name, requests, tokens, weight, unit, share })), [
    { name: 'turn-only', requests: 2, tokens: 0, weight: 2, unit: 'turns', share: 1 },
  ]);
});

test('GET /api/projects espone unità e share Muse', async () => {
  const { temp, root: museRoot } = fixtureRoot('tokenized');
  const server = createServer(config({ budgets: { Alpha: { match: ['alpha-app'] } } }), {
    fetchImpl: fakeFetch,
    root: path.join(temp, 'claude'),
    museRoot,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/projects`)).json();
    assert.equal(body.muse.unit, 'tokens');
    assert.equal(body.muse.projects.find((p) => p.name === 'Alpha').share, 0.5);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
