// Il riassuntore delle sessioni: scrive in italiano, e senza lavoro da riassumere risponde NIENTE (turno saltato).
// Le risposte «meta» in inglese (rifiuti, domande, «I'm Claude…») non entrano mai nella cronologia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_SYSTEM, parseSummary } from '../lib.mjs';

test('il prompt chiede italiano e NIENTE quando non c\'è lavoro', () => {
  assert.match(SUMMARY_SYSTEM, /in italiano/);
  assert.match(SUMMARY_SYSTEM, /rispondi solo: NIENTE$/);
  assert.doesNotMatch(SUMMARY_SYSTEM, /^You summarize/);
});

test('NIENTE e risposte su di sé: il turno si salta', () => {
  assert.deepEqual(parseSummary('NIENTE'), { skip: true });
  assert.deepEqual(parseSummary("I'm Claude, an AI assistant made by Anthropic. I can't process this."), { skip: true });
  assert.deepEqual(parseSummary('I appreciate you sharing this routing information, but I should clarify my role.'), { skip: true });
  assert.deepEqual(parseSummary('Could you finish describing what the issue is?'), { skip: true });
  assert.equal(parseSummary(''), null);
});

test('un riassunto vero diventa input e azioni, senza le frasi meta in mezzo', () => {
  assert.deepEqual(parseSummary('Il calcolo delle fatture ora arrotonda al centesimo. I can help with more. Aggiunto il test sui resti.'),
    { input: 'Il calcolo delle fatture ora arrotonda al centesimo.', actions: ['Aggiunto il test sui resti.'] });
});
