import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickMuseQuota } from '../src/quota.mjs';
import { buildReport } from '../src/projects.mjs';
import { evaluateRules, runAlerts } from '../src/alerts.mjs';
import { loadMuseBudget } from '../src/budgets.mjs';
import { makeDemoRoot } from '../src/demo.mjs';

const resetsAt = Math.floor(Date.now() / 1000) + 5 * 86400;
const overview = { providers: [
  { id: 'claude', accounts: [{ id: 'c', label: 'me@example.com', active: true,
    quotas: [{ key: '7d', usedPct: 50, resetsAt }, { key: '5h', usedPct: 20, resetsAt }] }] },
  { id: 'muse', accounts: [{ id: 'muse-code', label: 'me@example.com', active: true,
    quotas: [{ key: '5h', usedPct: 4, resetsAt }, { key: '7d', usedPct: 36, resetsAt }] }] },
] };
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => overview });

test('pickMuseQuota legge la 7d dalla tray', () => {
  const q = pickMuseQuota(overview);
  assert.equal(q.weekPct, 36);
  assert.equal(q.fiveHourPct, 4);
});

test('pickMuseQuota tace senza provider muse', () => {
  assert.equal(pickMuseQuota({ providers: [] }), null);
});

test('report muse.quota uguale alla tray (±1)', async () => {
  const root = makeDemoRoot();
  const r = await buildReport({ quotaSource: { url: 'http://x' } }, { fetchImpl: fakeFetch, root });
  assert.ok(r.muse, 'sezione muse assente');
  assert.ok(Math.abs(r.muse.quota.weekPct - 36) <= 1, `quota ${r.muse.quota.weekPct}`);
  assert.ok(Math.abs(r.muse.quota.fiveHourPct - 4) <= 1);
});

test('avviso muse scatta una volta sola per finestra', async () => {
  const root = makeDemoRoot();
  const report = await buildReport({ quotaSource: { url: 'http://x' } }, { fetchImpl: fakeFetch, root });
  const rules = [{ scope: 'muse', threshold: 30, message: '{subject} {value}' }];
  const first = evaluateRules(report, rules);
  assert.equal(first.length, 1);
  assert.equal(first[0].id, 'muse:7d');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-muse-'));
  const config = { stateFile: path.join(dir, 'state.json'), alerts: { rules, notify: { command: `node -e "1"` } } };
  assert.equal((await runAlerts(report, config)).length, 1);
  assert.equal((await runAlerts(report, config)).length, 0, 'second run is silent');
});

test('loadMuseBudget legge la chiave muse di budgets.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-bud-'));
  const file = path.join(dir, 'budgets.json');
  fs.writeFileSync(file, JSON.stringify({ projects: {}, muse: { budgetPct: 80 } }));
  assert.equal(loadMuseBudget(file).budgetPct, 80);
  fs.writeFileSync(file, JSON.stringify({ projects: {} }));
  assert.equal(loadMuseBudget(file), null);
});
