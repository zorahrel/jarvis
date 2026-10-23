import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPolicies, evaluatePolicies, applyBlocks } from '../src/policy.mjs';
import { fetchHubBlocks } from '../modules/vdm/hub-policy.mjs';

const report = {
  account: { weekPct: 1 },
  projects: [{ name: 'PrinceOfPersia', weekPct: 3 }],
  codex: { quota: { weekPct: 16 }, projects: [{ name: 'PrinceOfPersia', weekPct: 1 }] },
  muse: { quota: { weekPct: 96 }, projects: [] },
  apiSpend: { last7d: 5, perKey: { a: { last7d: 5 } } },
};
const budgets = { PrinceOfPersia: { label: 'PoP', budgetPct: 10, enforce: true } };
const policies = defaultPolicies(budgets, { label: 'Muse', budgetPct: 80 });

test('sotto soglia: solo Muse al 96% avvisa, nessun blocco', () => {
  const r = evaluatePolicies(report, policies);
  assert.deepEqual(r.map((x) => [x.id, x.action]), [['muse', 'warn']]);
});

test('fake PoP sopra il 10% → block in dry-run, niente file scritto', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blk-')), 'blocks.json');
  const r = evaluatePolicies(report, policies, { fake: { 'project:PrinceOfPersia': 12 } });
  const hit = r.find((x) => x.id === 'project:PrinceOfPersia');
  assert.equal(hit.action, 'block');
  const out = applyBlocks(r, { dryRun: true, file });
  assert.deepEqual(out.blocked, ['PrinceOfPersia']);
  assert.equal(fs.existsSync(file), false);
  assert.equal(applyBlocks(r, { file }).written, true);
});

test('altri budget oltre soglia avvisano soltanto, anche se chiedono block', () => {
  const p = [{ id: 'codex', scope: 'codex', threshold: 10, action: 'block', enforce: true }, { id: 'api-spend', scope: 'api-spend', threshold: 1, action: 'block', enforce: true }];
  const r = evaluatePolicies(report, p);
  assert.deepEqual(r.map((x) => x.action), ['warn', 'warn']);
});

test('VDM prende i blocchi dall hub', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ firing: [{ action: 'block', project: 'PrinceOfPersia' }, { action: 'warn', project: 'x' }] }) });
  assert.deepEqual(await fetchHubBlocks('http://h', fetchImpl), ['PrinceOfPersia']);
  assert.deepEqual(await fetchHubBlocks('http://h', async () => { throw new Error('down'); }), []);
});
