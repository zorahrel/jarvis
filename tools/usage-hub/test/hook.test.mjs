import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchBudget, budgetMessage } from '../src/budgets.mjs';
import { buildStatus, writeStatus, readStatus, hookLine } from '../src/status.mjs';
import { buildReport } from '../src/projects.mjs';
import { runAlerts } from '../src/alerts.mjs';

const hook = path.resolve('bin/usage-hub-hook.mjs');
const budgets = { Pop: { label: 'PoP', budgetPct: 3, match: ['-workspace-pop-demo'], hint: 'lavoro meccanico su Muse Wonder' } };
const report = (pct) => ({
  account: { weekResetsAt: Date.now() + 86400000, weekPct: 60 },
  projects: [{ name: 'Pop', weekPct: pct }],
  muse: { projects: [{ name: 'Pop', requests: 5, tokens: 100 }] },
});

function runHook(cache, cwd, extra = {}) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd, ...extra }), encoding: 'utf8',
    env: { ...process.env, USAGE_HUB_CACHE: cache },
  });
  return { out: r.stdout.trim(), ms: performance.now() - t0, code: r.status };
}

test('cwd maps to a budget project through the sanitized path', () => {
  assert.equal(matchBudget('/Users/x/.openclaw/workspace/pop-demo', budgets), 'Pop');
  assert.equal(matchBudget('/Users/x/Projects/other', budgets), null);
});

test('status marks over-budget projects and carries Muse counts', () => {
  const s = buildStatus(report(7.6), budgets);
  assert.equal(s.projects.Pop.over, true);
  assert.equal(s.projects.Pop.muse.requests, 5);
  assert.equal(hookLine(s.projects.Pop), 'PoP: 7.6% della settimana, budget 3%: lavoro meccanico su Muse Wonder');
});

test('hook prints one line over budget, stays mute otherwise, and is fast', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hook-'));
  const file = path.join(cache, 'status.json');
  writeStatus(buildStatus(report(7.6), budgets), file);
  const hit = runHook(cache, '/Users/x/.openclaw/workspace/pop-demo');
  assert.equal(hit.out, 'PoP: 7.6% della settimana, budget 3%: lavoro meccanico su Muse Wonder');
  // il migliore di 3: con il Mac carico un avvio a freddo di node sfora per lo scheduler, un hook lento sfora sempre
  const ms = Math.min(hit.ms, ...[1, 2].map(() => runHook(cache, '/Users/x/.openclaw/workspace/pop-demo').ms));
  // il costo dell'hook oltre l'avvio di node, misurato nello stesso momento: a carico 60 node da solo ne prende 1500
  // (giro 10, barra rossa per il carico, non per l'hook); un hook lento sfora comunque
  const bare = Math.min(...[1, 2, 3].map(() => { const t0 = performance.now(); spawnSync(process.execPath, ['-e', '0']); return performance.now() - t0; }));
  assert.ok(ms < 300 || ms - bare < 200, `hook took ${Math.round(ms)} ms, node da solo ${Math.round(bare)} ms`);
  assert.equal(runHook(cache, '/Users/x/Projects/claude-usage-hub').out, '');
  writeStatus(buildStatus(report(1.2), budgets), file);
  assert.equal(runHook(cache, '/Users/x/.openclaw/workspace/pop-demo').out, '');
});

test('same session is warned once, then muted for 30 minutes', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hook-'));
  writeStatus(buildStatus(report(7.6), budgets), path.join(cache, 'status.json'));
  const cwd = '/Users/x/.openclaw/workspace/pop-demo';
  assert.notEqual(runHook(cache, cwd, { session_id: 's1' }).out, '');
  assert.equal(runHook(cache, cwd, { session_id: 's1' }).out, '');
  assert.notEqual(runHook(cache, cwd, { session_id: 's2' }).out, '');
});

test('cache of a closed week is ignored', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hook-'));
  const s = buildStatus(report(7.6), budgets);
  s.weekResetsAt = Date.now() - 1000;
  writeStatus(s, path.join(cache, 'status.json'));
  assert.equal(runHook(cache, '/Users/x/.openclaw/workspace/pop-demo').out, '');
});

test('check fires the budget rule once per week with the hint', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chk-')), 'state.json');
  const r = report(7.6);
  const rule = { scope: 'project', project: 'Pop', threshold: 3, message: budgetMessage(budgets.Pop).replace('{subject}', 'Pop') };
  const config = { stateFile, alerts: { rules: [rule], notify: { command: 'cat >/dev/null' } } };
  const first = await runAlerts(r, config);
  assert.equal(first[0].message, 'PoP: 7.6% della settimana, budget 3%: lavoro meccanico su Muse Wonder');
  assert.equal((await runAlerts(r, config)).length, 0);
});

test('buildReport adds Muse counts without a readable limit', async () => {
  const museRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-muse-'));
  const fetchImpl = async () => ({ ok: true, json: async () => ({ providers: [{ id: 'claude', accounts: [
    { id: 'a', active: true, quotas: [{ key: '7d', usedPct: 10, resetsAt: Math.floor(Date.now() / 1000) + 86400 }] }] }] }) });
  const r = await buildReport({ quotaSource: { url: 'http://x' } }, { fetchImpl, root: museRoot, museRoot });
  assert.equal(r.muse.limit, null);
  assert.deepEqual(r.muse.projects, []);
  assert.equal(readStatus(path.join(museRoot, 'nope.json')), null);
});
