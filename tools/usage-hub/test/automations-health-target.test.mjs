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

// 24/10: «sh -lc node …» gira col Node 18 di /usr/local/bin, la salute delle automazioni è caduta su node:sqlite.
const cmd = (argv) => findings({ now: Date.now(), jobs: [{ id: 'fd4c35a4-0000-0000-0000-000000000000', name: 'cron-health', enabled: true, payload: { kind: 'command', argv }, schedule: { kind: 'cron' } }], runsByJob: {}, delivered: {} }).filter((o) => o.kind === 'node vecchio');

test('cron che chiama node senza percorso: segnalato', () => {
  assert.equal(cmd(['sh', '-lc', 'node /x/cron-health.mjs']).length, 1);
  assert.equal(cmd(['cron-clean', 'Salute', 'sh', '-lc', 'cd /x && node y.mjs']).length, 1);
});

test('node col percorso, o la parola dentro un nome: niente', () => {
  assert.equal(cmd(['sh', '-lc', '/opt/homebrew/bin/node /x/cron-health.mjs']).length, 0);
  assert.equal(cmd(['sh', '-lc', 'python3 /x/node-check.py']).length, 0);
  assert.equal(cmd(['sh', '-lc', 'ls node_modules']).length, 0);
});
