import '../test-support/isolate-tmp.mjs';
// Storico per voce: gli esiti chiusi delle stesse fonti di last, più recenti per primi, tetto a 20.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyOf } from '../src/automations/model.mjs';

test('mappa gli esiti chiusi e scarta quelli ancora in corso', () => {
  const item = {
    runs: [
      { at: 3, outcome: 'ok' },
      { at: 2, outcome: 'failure' },
      { at: 1, outcome: 'running' },
      { at: 0, outcome: null },
    ],
  };
  assert.deepEqual(historyOf(item), [{ at: 3, outcome: 'ok' }]);
});

test('normalizza gli esiti delle fonti sui tre valori', () => {
  const item = {
    runs: [
      { at: 4, outcome: 'interrupted' },
      { at: 3, outcome: 'timed_out' },
      { at: 2, outcome: 'cancelled' },
      { at: 1, outcome: 'skipped' },
    ],
  };
  assert.deepEqual(historyOf(item).map((h) => h.outcome), ['error', 'error', 'skipped', 'skipped']);
});

test('più recenti per primi e tetto a 20', () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({ at: i, outcome: 'ok' }));
  const h = historyOf({ runs });
  assert.equal(h.length, 20);
  assert.equal(h[0].at, 29);
  assert.equal(h[19].at, 10);
});

test('senza runs non c\'è storico', () => {
  assert.deepEqual(historyOf({}), []);
});
