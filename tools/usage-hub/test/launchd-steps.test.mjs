import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStepRuns } from '../src/automations/sources/launchd.mjs';

test('job a passi: passi dell\'ultimo giro e storico dei giri da runs.jsonl', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steps-')), 'runs.jsonl');
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(f, [
    L({ run: 'a', step: 'memgit-snap', label: 'Foto', at: 1000, ms: 5, outcome: 'ok' }),
    L({ run: 'a', step: 'log-rotate', label: 'Log', at: 1100, ms: 5, outcome: 'error', note: 'exit 1' }),
    'riga sporca',
    L({ run: 'b', step: 'memgit-snap', label: 'Foto', at: 9000, ms: 7, outcome: 'ok' }),
    L({ run: 'b', step: 'agent-browser-update', label: 'Browser', at: 9010, ms: 0, outcome: 'skipped', note: 'solo il lunedì' }),
  ].join('\n') + '\n');
  const r = readStepRuns(f);
  assert.deepEqual(r.runs.map((x) => [x.at, x.outcome]), [[9000, 'ok'], [1000, 'error']]);
  assert.deepEqual(r.steps.map((s) => [s.id, s.outcome, s.note]), [['memgit-snap', 'ok', null], ['agent-browser-update', 'skipped', 'solo il lunedì']]);
  assert.equal(readStepRuns(f + '.manca'), null);
});
