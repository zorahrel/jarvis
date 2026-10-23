import '../test-support/isolate-tmp.mjs';
// Il giudizio di Attilio: l'ultimo voto vince, i silenzi scaduti spariscono.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  append, readAll, buildState, stateFor, openItems,
  mutesAsAccepted, fixesForHealth,
} from '../src/automations/feedback.mjs';
import { operatore } from '../src/operatore.mjs';

process.env.USAGE_HUB_OPERATORE = 'operatore-test';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-'));
const monthName = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`;
};
const totalSize = (dir) => {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
      .reduce((s, n) => s + fs.statSync(path.join(dir, n)).size, 0);
  } catch {
    return 0;
  }
};
const stateOf = (dir, opts) => buildState(readAll({ dir }).rows, opts);

test('scrittura e rilettura: 3 append, file del mese, solo crescita', () => {
  const dir = tmp();
  const at = '2026-03-05T10:00:00.000Z';
  const before = totalSize(dir);
  const r1 = append({ key: 'cron:a', kind: 'vote', v: 'ok', fp: 'f1', at }, { dir });
  const s1 = totalSize(dir);
  const r2 = append({ key: 'cron:a', kind: 'note', note: 'ciao', at }, { dir });
  const s2 = totalSize(dir);
  const r3 = append({ key: 'cron:b', kind: 'vote', v: 'ok', at }, { dir });
  const s3 = totalSize(dir);
  assert.ok(s1 > before && s2 > s1 && s3 > s2);
  const f = path.join(dir, monthName(at));
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 3);
  const { rows, bad } = readAll({ dir });
  assert.equal(bad, 0);
  assert.deepEqual(rows, [r1, r2, r3]);
  assert.equal(r1.by, operatore());
  assert.equal(r1.src, 'hub');
  assert.ok(r1.id);
});

test('ultimo voto vince, e la riga vecchia esce da open', () => {
  const dir = tmp();
  const k = 'cron:job';
  append({ key: k, kind: 'vote', v: 'ok', at: '2026-03-10T10:00:00.000Z' }, { dir });
  const ch = append({ key: k, kind: 'vote', v: 'cambia', note: 'fai altro', at: '2026-03-10T11:00:00.000Z' }, { dir });
  let s = stateOf(dir).get(k);
  assert.equal(s.vote.v, 'cambia');
  assert.ok(s.open.some((r) => r.id === ch.id));
  append({ key: k, kind: 'vote', v: 'ok', at: '2026-03-10T12:00:00.000Z' }, { dir });
  s = stateOf(dir).get(k);
  assert.equal(s.vote.v, 'ok');
  assert.ok(!s.open.some((r) => r.id === ch.id));
});

test('silenzio che scade sparisce, per sempre resta', () => {
  const dir = tmp();
  const now = Date.now();
  const k = 'cron:rumoroso';
  append({ key: k, kind: 'mute', until: new Date(now + 3600_000).toISOString(), why: 'tregua', at: new Date(now).toISOString() }, { dir });
  assert.ok(stateOf(dir, { now }).get(k).mute);
  assert.equal(stateOf(dir, { now: now + 2 * 3600_000 }).get(k).mute, null);
  const dir2 = tmp();
  append({ key: k, kind: 'mute', until: null, why: 'basta', at: new Date(now).toISOString() }, { dir: dir2 });
  assert.ok(stateOf(dir2, { now: now + 10 ** 12 }).get(k).mute);
});

test('migration a→b→c sposta tutto, i cicli non girano in tondo', () => {
  const dir = tmp();
  const at = '2026-03-10T10:00:00.000Z';
  append({ key: 'cron:a', kind: 'vote', v: 'ok', at }, { dir });
  append({ key: 'cron:b', kind: 'note', note: 'nota', at }, { dir });
  append({ key: 'cron:a', kind: 'migration', from: 'cron:a', to: 'cron:b', at }, { dir });
  append({ key: 'cron:b', kind: 'migration', from: 'cron:b', to: 'cron:c', at }, { dir });
  const st = stateOf(dir);
  assert.ok(!st.has('cron:a') && !st.has('cron:b'));
  const c = st.get('cron:c');
  assert.equal(c.vote.v, 'ok');
  assert.equal(c.notes.length, 1);
  const dir2 = tmp();
  append({ key: 'cron:a', kind: 'vote', v: 'ok', at }, { dir: dir2 });
  append({ key: 'cron:a', kind: 'migration', from: 'cron:a', to: 'cron:b', at }, { dir: dir2 });
  append({ key: 'cron:b', kind: 'migration', from: 'cron:b', to: 'cron:a', at }, { dir: dir2 });
  const st2 = stateOf(dir2);
  assert.equal([...st2.values()].reduce((n, s) => n + (s.vote ? 1 : 0), 0), 1);
});

test('fp vecchio segnala il cambiamento dopo il voto', () => {
  const dir = tmp();
  const k = 'cron:job';
  append({ key: k, kind: 'vote', v: 'ok', fp: 'x', at: '2026-03-10T10:00:00.000Z' }, { dir });
  const st = stateOf(dir);
  assert.equal(stateFor(st, k, 'y').changedSinceVote, true);
  assert.equal(stateFor(st, k, 'x').changedSinceVote, false);
  assert.equal(stateFor(st, 'cron:assente', 'y').changedSinceVote, false);
});

test('resolve chiude una complaint, undo ripristina il voto di prima', () => {
  const dir = tmp();
  const k = 'cron:job';
  append({ key: k, kind: 'vote', v: 'ok', at: '2026-03-10T10:00:00.000Z' }, { dir });
  const bad = append({ key: k, kind: 'vote', v: 'indietro', at: '2026-03-10T11:00:00.000Z' }, { dir });
  const comp = append({ key: k, kind: 'complaint', note: 'fa rumore', at: '2026-03-10T11:30:00.000Z' }, { dir });
  let s = stateOf(dir).get(k);
  assert.equal(s.vote.v, 'indietro');
  assert.ok(openItems(stateOf(dir)).some((e) => e.row.id === comp.id));
  append({ kind: 'resolve', ref: comp.id, at: '2026-03-10T12:00:00.000Z' }, { dir });
  s = stateOf(dir).get(k);
  assert.ok(!s.open.some((r) => r.id === comp.id));
  assert.ok(s.open.some((r) => r.id === bad.id));
  append({ kind: 'undo', ref: bad.id, at: '2026-03-10T13:00:00.000Z' }, { dir });
  s = stateOf(dir).get(k);
  assert.equal(s.vote.v, 'ok');
  assert.ok(!s.open.some((r) => r.id === bad.id));
});

test('validazione: il file non cresce se la riga è sbagliata', () => {
  const dir = tmp();
  const at = '2026-03-10T10:00:00.000Z';
  assert.throws(() => append({ key: 'cron:a', kind: 'vote', v: 'cambia', at }, { dir }));
  assert.throws(() => append({ key: 'cron:a', kind: 'mute', until: null, at }, { dir }));
  assert.throws(() => append({ key: 'cron:a', kind: 'boh', at }, { dir }));
  assert.throws(() => append({ kind: 'vote', v: 'ok', at }, { dir }));
  assert.equal(totalSize(dir), 0);
});

test('mutesAsAccepted e fixesForHealth nella forma di cron-health', () => {
  const dir = tmp();
  const at = '2026-03-10T10:00:00.000Z';
  append({ key: 'health:cron:pippo', kind: 'mute', until: null, why: 'silenzio', at }, { dir });
  append({ key: 'cron:pippo', kind: 'fix', why: 'riparato', at }, { dir });
  const st = stateOf(dir);
  assert.deepEqual(mutesAsAccepted(st), [{ match: 'cron:pippo', why: 'silenzio' }]);
  assert.deepEqual(fixesForHealth(st), [{ job: 'pippo', at, why: 'riparato' }]);
});
