import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { weighUsage, projectName } from '../src/usage.mjs';
import { pickClaudeAccount } from '../src/quota.mjs';
import { buildReport } from '../src/projects.mjs';
import { evaluateRules, runAlerts } from '../src/alerts.mjs';
import { createServer } from '../src/server.mjs';
import { makeDemoRoot } from '../src/demo.mjs';

const testOperator = process.env.USAGE_HUB_OPERATORE = 'operatore-test';

const resetsAt = Math.floor(Date.now() / 1000) + 3 * 86400;
const overview = { providers: [{ id: 'claude', accounts: [
  { id: 'x', label: 'someone@example.com', active: false, quotas: [{ key: '7d', usedPct: 99, resetsAt }] },
  { id: 'y', label: 'me@example.com', active: true, quotas: [{ key: '7d', usedPct: 50, resetsAt }, { key: '5h', usedPct: 20, resetsAt: resetsAt - 1000 }] },
] }] };
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => overview });

test('weights follow the price ratios', () => {
  assert.equal(weighUsage({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }), 100 + 50 + 125 + 100);
});

test('project name: group match beats cwd basename', () => {
  assert.equal(projectName('-a-b', '/x/y/app', []), 'app');
  assert.equal(projectName('-a-pop-demo', '/x/z', [{ name: 'Pop', match: ['pop-demo'] }]), 'Pop');
});

test('picks the active account only', () => {
  const a = pickClaudeAccount(overview);
  assert.equal(a.weekPct, 50);
  assert.equal(a.fiveHourPct, 20);
});

test('report shares add up to the account percentage', async () => {
  const root = makeDemoRoot();
  const r = await buildReport({ quotaSource: { url: 'http://x' } }, { fetchImpl: fakeFetch, root });
  const sum = r.projects.reduce((s, p) => s + p.weekPct, 0);
  assert.ok(Math.abs(sum - 50) < 0.6, `sum ${sum}`);
  assert.equal(r.projects[0].name, 'billing-api');
  assert.ok(!r.account.label.includes('@'), 'account label masked');
});

test('alert with a low threshold runs the configured command once per week', async () => {
  const root = makeDemoRoot();
  const report = await buildReport({ quotaSource: { url: 'http://x' } }, { fetchImpl: fakeFetch, root });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uh-')), 'fired.txt');
  const config = {
    stateFile: path.join(path.dirname(out), 'state.json'),
    alerts: {
      rules: [{ scope: 'project', project: 'billing-api', threshold: 0.1, message: '{subject} {value}' }],
      notify: { command: `node -e "process.stdin.pipe(require('fs').createWriteStream(process.argv[1]))" "${out}"` },
    },
  };
  const first = await runAlerts(report, config);
  assert.equal(first.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).id, 'project:billing-api');
  assert.equal((await runAlerts(report, config)).length, 0, 'second run is silent');
});

test('rules below the threshold stay quiet', async () => {
  const report = await buildReport({ quotaSource: { url: 'http://x' } }, { fetchImpl: fakeFetch, root: makeDemoRoot() });
  assert.equal(evaluateRules(report, [{ scope: 'account', metric: '7d', threshold: 80 }]).length, 0);
});

test('webhook receives the event', async () => {
  const got = new Promise((resolve) => {
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.end('ok'); srv.close(); resolve(JSON.parse(b)); }); });
    srv.listen(0, () => { globalThis.__hook = `http://127.0.0.1:${srv.address().port}`; });
  });
  await new Promise((r) => setTimeout(r, 100));
  const report = await buildReport({ quotaSource: { url: 'http://x' } }, { fetchImpl: fakeFetch, root: makeDemoRoot() });
  await runAlerts(report, { alerts: { rules: [{ scope: 'account', metric: '7d', threshold: 10 }], notify: { webhook: globalThis.__hook } } });
  assert.equal((await got).id, 'account:7d');
});

test('GET /api/projects answers with projects', async () => {
  const root = makeDemoRoot();
  const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] } }, { fetchImpl: fakeFetch, root });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const body = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/projects`)).json();
  srv.close();
  assert.ok(body.projects.length >= 4);
});

test('allow: gate brakes, override lifts the pacing brake, expiry brakes again', async () => {
  const { buildPace, gate } = await import('../src/pacing.mjs');
  const { addOverride, loadOverrides, activeOverrides, revokeOverride } = await import('../src/overrides.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ov-')), 'overrides.json');
  const now = Date.now();
  const mk = (used) => buildPace({ providers: [{ id: 'codex', accounts: [{ id: 'c', label: 'c', quotas: [{ key: '7d', usedPct: used, resetsAt: Math.floor(now / 1000) + 5 * 86400 }] }] }] }, { now });
  const ov = (at) => activeOverrides(loadOverrides(file), at);
  const run = (rows, at) => gate(rows, 'batch', { provider: 'codex', now: at, overrides: ov(at) });
  const fast = mk(36); // 36% usato dopo ~29% di settimana: ritmo > 1
  assert.equal(run(fast, now).go, false);
  addOverride({ provider: 'codex', hours: 12, by: testOperator, reason: 'test' }, { now, file });
  const g = run(fast, now);
  assert.equal(g.go, true);
  assert.equal(g.override.by, testOperator);
  assert.equal(run(mk(100), now).go, false, 'quota esaurita resta esaurita');
  assert.equal(run(fast, now + 13 * 3600000).go, false, 'scaduto: frena di nuovo');
  revokeOverride('codex', { now, file });
  assert.equal(run(fast, now).go, false);
});
