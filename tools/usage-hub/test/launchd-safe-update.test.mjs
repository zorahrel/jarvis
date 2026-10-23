import '../test-support/isolate-tmp.mjs';
// Il safe-update esce con errore quando rimanda l'update per OpenClaw occupato: non è rotto, né lo è un update in corso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rinviatoOInCorso } from '../src/automations/sources/launchd.mjs';

const L = 'com.jarvis.openclaw-safe-update';
const logWith = (last) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'su-')), 'log');
  fs.writeFileSync(f, `2026-10-23 22:01:42 OpenClaw 2026.10.5 -> 2026.10.6\n${last}\n`);
  return f;
};

test('update interrotto che riprova da solo non è rotto', () => {
  const log = logWith("2026-10-23 22:25:34 update interrotto prima dell'attivazione: 2026.10.5 resta, riprovo la notte prossima");
  assert.equal(rinviatoOInCorso(L, Date.now(), log), true);
});

test('update partito da poco senza esito è in corso', () => {
  const log = logWith('2026-10-23 22:21:07 openclaw update --yes --json --tag 2026.10.6');
  assert.equal(rinviatoOInCorso(L, Date.now(), log), true);
});

test('un errore vero resta errore', () => {
  const log = logWith('2026-10-23 22:30:00 FATAL: rollback non riuscito');
  assert.equal(rinviatoOInCorso(L, Date.now(), log), false);
});

test('gli altri job non cambiano', () => {
  const log = logWith('riprovo');
  assert.equal(rinviatoOInCorso('com.jarvis.altro', Date.now(), log), false);
});
