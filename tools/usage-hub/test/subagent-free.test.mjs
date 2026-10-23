import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProjects } from '../src/usage.mjs';
import { scanFree } from '../src/free.mjs';

const line = (cwd, output) => JSON.stringify({ timestamp: new Date().toISOString(), cwd, message: { usage: { input_tokens: 10, output_tokens: output } } }) + '\n';

test('i subagent contano nel progetto del padre e si vedono a parte', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  const dir = path.join(root, '-w-alpha');
  fs.mkdirSync(path.join(dir, 'sess1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess1.jsonl'), line('/w/alpha', 10));
  fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-x.jsonl'), line('/w/alpha', 20) + line('/w/alpha', 20));
  const out = scanProjects({ root, sinceMs: 0 });
  assert.equal(out.alpha.requests, 3);
  assert.equal(out.alpha.subRequests, 2);
  assert.equal(out.alpha.subTokens, 2 * (10 + 100));
});

test('scanFree conta le richieste ok per canale nella finestra', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), 'free.log');
  fs.writeFileSync(file, '2026-10-17T10:00:00 ok gemini json\n2026-10-17T10:01:00 fail gemini 429 x\n2026-10-17T10:02:00 ok gemini stream\n2026-10-01T10:00:00 ok old json\n');
  const r = scanFree({ file, sinceMs: Date.parse('2026-10-10T00:00:00') });
  assert.equal(r.requests, 2);
  assert.deepEqual(Object.keys(r.channels), ['gemini']);
  assert.equal(scanFree({ file: '/nonexistent' }), null);
});
