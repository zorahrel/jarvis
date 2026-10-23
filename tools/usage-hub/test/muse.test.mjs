import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMuse } from '../src/muse.mjs';

function dayParts(ms) {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return [y, m, day];
}

function metaLine(cwd) {
  return JSON.stringify({ payload_type: 'runtime.session.metadata', payload: { record: { workspace_root: cwd } } });
}

function eventLine({ tsMs, model, usage, kind = 'model_completed' }) {
  return JSON.stringify({
    payload_type: 'runtime.session',
    recorded_at: Math.floor(tsMs * 1000),
    payload: { event: { kind, model, usage } },
  });
}

test('scanMuse conta richieste, raggruppa e filtra per since', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-'));
  const now = Date.now();
  const sinceMs = now - 7 * 86400000;
  const oldTs = now - 30 * 86400000;

  const cwd = '/home/u/workspace-pop-demo';
  const [y, m, d] = dayParts(now);
  const sessA = path.join(root, y, m, d, 'sess-a');
  fs.mkdirSync(sessA, { recursive: true });

  const usage1 = { input_tokens: 10, output_tokens: 20, cached_tokens: 5, reasoning_tokens: 3 };
  const usage2 = { input_tokens: 7, output_tokens: 8, cached_tokens: 0, reasoning_tokens: 1 };
  const usageW = { input_tokens: 4, output_tokens: 4, cached_tokens: 0, reasoning_tokens: 2 };
  const usageF = { input_tokens: 100, output_tokens: 200, cached_tokens: 0, reasoning_tokens: 0 };

  const lines = [
    metaLine(cwd),
    eventLine({ tsMs: now - 1000, model: 'claude-x', usage: usage1 }),
    eventLine({ tsMs: now - 2000, model: 'muse-wonder-1.0-turbo', usage: usageW }),
    eventLine({ tsMs: now - 3000, model: 'muse-wonder-full-mega', usage: usageF }),
    eventLine({ tsMs: now - 4000, model: 'other-model', usage: usage2 }),
    // Fuori finestra: stesso file, timestamp vecchio.
    eventLine({ tsMs: oldTs, model: 'claude-x', usage: { input_tokens: 9999, output_tokens: 9999, reasoning_tokens: 9999 } }),
    // Rumore: riga senza marker, non deve rompersi.
    JSON.stringify({ hello: 'world' }),
  ];
  fs.writeFileSync(path.join(sessA, 'session.jsonl'), lines.join('\n') + '\n');

  // Sessione vecchia: giorno vecchio + mtime vecchio, deve essere saltata.
  const [oy, om, od] = dayParts(oldTs);
  const sessB = path.join(root, oy, om, od, 'sess-b');
  fs.mkdirSync(sessB, { recursive: true });
  const otherCwd = '/home/u/other-project';
  const bFile = path.join(sessB, 'session.jsonl');
  fs.writeFileSync(
    bFile,
    [metaLine(otherCwd), eventLine({ tsMs: oldTs, model: 'claude-x', usage: usage1 })].join('\n') + '\n',
  );
  const oldDate = new Date(oldTs);
  fs.utimesSync(bFile, oldDate, oldDate);

  const groups = [{ name: 'Pop', match: ['-workspace-pop-demo'] }];
  const out = scanMuse({ root, sinceMs, groups });

  // Raggruppato sotto Pop via dirName (cwd con / e . in -).
  assert.ok(out.Pop, 'manca il gruppo Pop');
  const e = out.Pop;
  assert.equal(e.requests, 4);
  assert.equal(e.wonderRequests, 1);
  assert.equal(e.inputTokens, 10 + 4 + 100 + 7);
  assert.equal(e.outputTokens, 20 + 4 + 200 + 8);
  assert.equal(e.reasoningTokens, 3 + 2 + 0 + 1);
  assert.ok(e.lastAt >= now - 5000 && e.lastAt <= now + 1000, `lastAt ${e.lastAt}`);

  // La sessione vecchia non crea chiavi.
  assert.equal(out['other-project'], undefined);
  assert.deepEqual(Object.keys(out), ['Pop']);
});
