import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNew } from '../src/alerts.mjs';

const NOW = Date.now();
const H = 3600000;

// reset memorizzato nel futuro ma diverso di 90 s da quello dell'evento → tace
test('stesso id, reset memorizzato futuro anche se diverso di 90 s → filtrato', () => {
  const resetAt = NOW + 4 * 24 * H;
  const events = [{ id: 'pace:codex/utente@example.com', subject: 'codex pace', week: resetAt + 90000 }];
  const report = { at: NOW };
  const state = { 'pace:codex/utente@example.com': resetAt };
  assert.deepEqual(filterNew(events, state, report), []);
});

// reset memorizzato già passato → nuovo
test('reset memorizzato già passato → nuovo', () => {
  const events = [{ id: 'pace:codex/utente@example.com', subject: 'codex pace', week: NOW + 4 * 24 * H }];
  const report = { at: NOW };
  const state = { 'pace:codex/utente@example.com': NOW - 1000 };
  assert.deepEqual(filterNew(events, state, report), events);
});

// stato vuoto → nuovo
test('stato vuoto → nuovo', () => {
  const events = [{ id: 'pace:codex/utente@example.com', subject: 'codex pace', week: NOW + 4 * 24 * H }];
  const report = { at: NOW };
  assert.deepEqual(filterNew(events, {}, report), events);
});

// evento 'account 5h' con reset 5h memorizzato nel futuro → tace
test("evento 'account 5h' con fiveHourResetsAt futuro → filtrato", () => {
  const events = [{ id: 'account:5h', subject: 'account 5h', week: NOW + 2 * H }];
  const report = { at: NOW, account: { fiveHourResetsAt: NOW + 2 * H } };
  const state = { 'account:5h': NOW + 2 * H };
  assert.deepEqual(filterNew(events, state, report), []);
});
