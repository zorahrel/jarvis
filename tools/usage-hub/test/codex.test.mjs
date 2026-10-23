import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodex, splitCodex } from '../src/codex.mjs';
import { pickCodexQuota } from '../src/quota.mjs';

function session(root, name, cwd, events) {
  const dir = path.join(root, '2026', '10', '18');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd } })];
  let total = 0;
  for (const [input, cached, output] of events) {
    const last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output };
    total += input + output;
    lines.push(JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } } }));
    // evento ripetuto con lo stesso totale: non deve contare due volte
    lines.push(lines[lines.length - 1]);
  }
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), lines.join('\n') + '\n');
}

test('split Codex per cwd: la somma torna alla % globale (±2pt)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  session(root, 'a', '/w/alpha', [[1000, 200, 100], [500, 0, 50]]);
  session(root, 'b', '/w/beta', [[4000, 3000, 300]]);
  session(root, 'c', '/w/pop-demo', [[100, 0, 10]]);
  const raw = scanCodex({ root, sinceMs: 0, groups: [{ name: 'PoP', match: ['pop-demo'] }] });
  assert.deepEqual(Object.keys(raw).sort(), ['PoP', 'alpha', 'beta']);
  assert.equal(raw.alpha.requests, 2);
  const split = splitCodex(raw, 16);
  const sum = split.reduce((s, p) => s + p.weekPct, 0);
  assert.ok(Math.abs(sum - 16) <= 2, `somma ${sum}`);
});

test('pickCodexQuota legge il 7d del provider codex', () => {
  const q = pickCodexQuota({ providers: [{ id: 'codex', accounts: [{ label: 'x', quotas: [{ key: '7d', usedPct: 16, resetsAt: 100 }] }] }] });
  assert.equal(q.weekPct, 16);
  assert.equal(pickCodexQuota({ providers: [] }), null);
});

test('buildApiSpend: righe per chiave corrispondono al totale', async () => {
  const { buildApiSpend } = await import('../src/projects.mjs');
  const { recordApiSpend } = await import('../modules/vdm/api-spend.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-')), 'api-spend.json');
  const now = Date.now();
  recordApiSpend({ keyName: 'a', model: 'claude-sonnet-4-6', usage: { input: 333_333 }, now, file });
  recordApiSpend({ keyName: 'b', model: 'claude-sonnet-4-6', usage: { output: 77_777 }, now, file });
  const s = buildApiSpend({ apiSpendFile: file }, now);
  const sum = Object.values(s.perKey).reduce((x, r) => x + r.last7d, 0);
  assert.ok(Math.abs(sum - s.last7d) < 1e-9);
  assert.equal(Object.keys(s.perKey).length, 2);
});
