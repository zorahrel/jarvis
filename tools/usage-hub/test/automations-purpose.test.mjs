import '../test-support/isolate-tmp.mjs';
// Scopo per voce: area (descrizione, poi tabella, poi gruppo), frase «cosa fa», frase «se si rompe».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AREAS, purposeOf } from '../src/automations/purpose.mjs';
import { executorOf } from '../src/automations/sources/workflows.mjs';
import { savedTokens } from '../src/automations/model.mjs';

const AREA_IDS = new Set(AREAS.map((a) => a.id));
const TABLE = JSON.parse(fs.readFileSync(new URL('../src/automations/purpose.json', import.meta.url), 'utf8'));

test('ogni voce della tabella ha un’area valida e una frase se si rompe', () => {
  for (const [key, row] of Object.entries(TABLE)) {
    assert.ok(AREA_IDS.has(row.area), `${key}: area ${row.area}`);
    assert.ok(row.seSiRompe && row.seSiRompe.length > 10, `${key}: manca seSiRompe`);
  }
});

test('l’area della descrizione vince sulla tabella', () => {
  const key = 'lobster:smoke';
  const p = purposeOf(key, { area: 'clienti', cosa: 'x' }, 'macchine');
  assert.equal(p.area, 'clienti');
  assert.equal(p.areaSource, 'descrizione');
});

test('una voce non in tabella prende l’area dal gruppo vecchio', () => {
  const p = purposeOf('nuova:voce', null, 'dati');
  assert.equal(p.area, 'backup-sicurezza');
  assert.equal(p.areaSource, 'gruppo');
  assert.equal(p.seSiRompe, null);
});

test('la frase cosa fa per te viene dalla descrizione, senza inventare', () => {
  assert.equal(purposeOf('nuova:voce', { cosa: 'Fa una cosa.' }, 'arriva').cosaFaPerTe, 'Fa una cosa.');
  assert.equal(purposeOf('nuova:voce', null, 'arriva').cosaFaPerTe, null);
});

test('l’esecutore si ricava dal modello, senza indovinare', () => {
  assert.equal(executorOf('claude-opus-5-5'), 'claude');
  assert.equal(executorOf('gpt-5-codex'), 'codex');
  assert.equal(executorOf('nvidia/nemotron-ultra'), 'free');
  assert.equal(executorOf('muse-1'), 'muse');
  assert.equal(executorOf('modello-sconosciuto'), null);
  assert.equal(executorOf(null), null);
});

test('token risparmiati: solo i passi non Claude, null senza token', () => {
  const steps = [
    { executor: 'claude', tokens: 1000 },
    { executor: 'free', tokens: 300 },
    { executor: 'codex', tokens: 200 },
    { executor: null, tokens: 50 },
  ];
  assert.equal(savedTokens(steps), 500);
  assert.equal(savedTokens([{ executor: 'free', tokens: null }]), null);
  assert.equal(savedTokens([]), null);
});
