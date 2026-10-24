import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findings } from '../src/automations/health.mjs';

// 24/10: un cron che avvisa su WhatsApp senza destinatario fallisce a ogni giro e l'avviso non arriva mai.
const job = (delivery) => ({ id: '6cf1fc0e-6260-4d19-8641-60ecb7d089ce', name: 'aws-case-check', enabled: true, payload: { kind: 'agentTurn' }, schedule: { kind: 'every' }, delivery });
const run = (delivery) => findings({ now: Date.now(), jobs: [job(delivery)], runsByJob: {}, delivered: {} }).filter((o) => o.kind === 'senza destinatario');

test('avviso su un canale senza destinatario: segnalato', () => {
  const out = run({ mode: 'announce', channel: 'whatsapp' });
  assert.equal(out.length, 1);
  assert.match(out[0].line, /aws-case-check .*whatsapp senza destinatario/);
});

test('con destinatario, su «last» o senza avviso: niente', () => {
  assert.equal(run({ mode: 'announce', channel: 'whatsapp', to: 'qualcuno' }).length, 0);
  assert.equal(run({ mode: 'announce', channel: 'last' }).length, 0);
  assert.equal(run({ mode: 'none', channel: 'last' }).length, 0);
  assert.equal(run(undefined).length, 0);
});
