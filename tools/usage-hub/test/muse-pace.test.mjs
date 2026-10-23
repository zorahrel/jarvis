import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRules } from '../src/alerts.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'muse-pace');

test('avviso Muse segnala il ritmo sopra soglia con atteso, reset e primi tre progetti', () => {
  const report = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'above.json'), 'utf8'));
  const events = evaluateRules(report);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.id, 'muse:pace');
  assert.equal(event.expectedPct, 42.9);
  assert.deepEqual(event.projects.map((p) => p.name), ['alpha', 'beta', 'gamma']);
  assert.match(event.message, /usato 65%/);
  assert.match(event.message, /atteso 42,9%/);
  assert.match(event.message, /reset/);
  assert.match(event.message, /alpha 60%, beta 30%, gamma 10%/);
  assert.doesNotMatch(event.message, /delta/);
});

test('nessun avviso Muse quando la quota resta in ritmo', () => {
  const report = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'on-pace.json'), 'utf8'));
  assert.deepEqual(evaluateRules(report), []);
});
