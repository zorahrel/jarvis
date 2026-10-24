import '../test-support/isolate-tmp.mjs';
// Barra T2: un caso per evento, su item sintetici con `now` fisso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { levelOf, fromFindings } from '../src/automations/levels.mjs';
import { buildModel } from '../src/automations/model.mjs';
import { buildState } from '../src/automations/feedback.mjs';
import { NOW, buildOk, buildProblemi } from './fixtures/automations/make-models.mjs';

const T = Date.parse('2026-10-20T08:00:00+02:00'); // martedì
const MIN = 60000;
const H = 3600000;
const DAY = 24 * H;
const SUN = Date.parse('2026-10-18T03:19:00+02:00'); // domenica alle 3:19

const raw = (over = {}) => ({
  key: 'cron:prova', provider: 'openclaw', name: 'prova', enabled: true,
  everyMs: null, when: 'ogni giorno', next: null, nextApprox: false, expectedLast: null,
  last: { at: null, outcome: null, delivered: null, error: null },
  runs: [], consecutiveErrors: 0, runsToday: 0,
  who: 'test', reportsTo: 'nessun messaggio',
  tech: { schedule: null, exit: null, command: null, prompt: null, label: null, url: null },
  ...over,
});
const noFb = () => ({ vote: null, changedSinceVote: false, mute: null, open: [], notes: [], history: [] });
const lv = (item, over = {}) => levelOf(item, { now: T, fb: noFb(), ...over });
const errs = (n, end = T) => Array.from({ length: n }, (_, i) => ({ at: end - i * MIN, outcome: 'error' }));

test('salute: exit perdonata non è un fallimento', () => {
  const at = T - H;
  const r = lv(raw({
    everyMs: DAY,
    last: { at, outcome: 'error', delivered: 'none', error: 'exited with code 1' },
    runs: [{ at, outcome: 'error' }], consecutiveErrors: 1,
    tech: { schedule: null, exit: 1, command: null, prompt: null, label: null, url: null },
  }), { desc: { okExit: [0, 1] } });
  assert.equal(r.level, 'va');
});

test('posta ogni minuto: 1-2 errori va, 10 di fila rotto', () => {
  const mk = (runs, ce) => raw({
    everyMs: MIN,
    last: { at: runs[0]?.at ?? null, outcome: runs[0]?.outcome ?? null, delivered: 'none', error: runs[0]?.outcome === 'error' ? 'boom' : null },
    runs, consecutiveErrors: ce,
  });
  assert.equal(lv(mk(errs(1), 1)).level, 'va');
  assert.equal(lv(mk(errs(2), 2)).level, 'va');
  const r10 = lv(mk(errs(10), 10));
  assert.equal(r10.level, 'rotto');
  assert.match(r10.reason, /di fila/);
});

test('posta: dopo 1 ok con 10 errori dietro resta rotto, con 2 ok torna va', () => {
  const rec = raw({
    everyMs: MIN,
    last: { at: T, outcome: 'ok', delivered: 'none', error: null },
    runs: [{ at: T, outcome: 'ok' }, ...errs(10, T - MIN)], consecutiveErrors: 0,
  });
  const r = lv(rec);
  assert.equal(r.level, 'rotto');
  assert.match(r.reason, /riprendendo/);
  const healed = raw({
    everyMs: MIN,
    last: { at: T, outcome: 'ok', delivered: 'none', error: null },
    runs: [{ at: T, outcome: 'ok' }, { at: T - MIN, outcome: 'ok' }, ...errs(10, T - 2 * MIN)], consecutiveErrors: 0,
  });
  assert.equal(lv(healed).level, 'va');
});

test('collaudo settimanale github: un errore basta', () => {
  const at = T - 2 * H;
  const r = lv(raw({
    key: 'gh:prova/app/collaudo.yml', provider: 'github', name: 'collaudo', everyMs: 7 * DAY,
    expectedLast: at, last: { at, outcome: 'error', delivered: null, error: null },
    runs: [{ at, outcome: 'error' }], consecutiveErrors: 1,
  }));
  assert.equal(r.level, 'rotto');
  assert.match(r.reason, /ha fallito/);
});

test('aggiornamento launchd giornaliero: un errore basta', () => {
  const at = T - 2 * H;
  const r = lv(raw({
    key: 'launchd:com.prova.sicuro', provider: 'launchd', name: 'sicuro', everyMs: DAY,
    expectedLast: at, last: { at, outcome: 'error', delivered: null, error: null },
    runs: [{ at, outcome: 'error' }], consecutiveErrors: 1,
    tech: { schedule: '{}', exit: 1, command: 'aggiorna.sh', prompt: null, label: 'sicuro', url: null },
  }));
  assert.equal(r.level, 'rotto');
});

test('backup: la prova esterna vale più dell’exit 0', () => {
  const words = 'manca la prova: nessun commit tra le 4:32 e le 5:30';
  const at = T - H;
  const r = lv(raw({
    everyMs: DAY, last: { at, outcome: 'ok', delivered: 'none', error: null }, runs: [{ at, outcome: 'ok' }],
  }), { proof: { ok: false, at: T - 30 * MIN, words } });
  assert.equal(r.level, 'rotto');
  assert.equal(r.reason, words);
});

test('lobster fermo al cancello: serve Attilio', () => {
  const r = lv(raw({
    key: 'lobster:report', provider: 'lobster', name: 'report',
    last: { at: T - 3 * H, outcome: 'running', delivered: null, error: null }, runs: [],
    waitingApproval: { step: 'approva-invio', since: T - 3 * H, token: 't', file: null },
  }));
  assert.equal(r.level, 'te');
  assert.match(r.reason, /tuo ok/);
});

test('task desktop mai partito: te; spento: nascosto', () => {
  const base = {
    key: 'desktop:festa', provider: 'desktop', name: 'Festa', everyMs: null,
    last: { at: null, outcome: null, delivered: null, error: null }, runs: [],
    fireAt: T - 2 * DAY, neverRan: true,
  };
  const r = lv(raw(base));
  assert.equal(r.level, 'te');
  assert.match(r.reason, /mai partito/);
  assert.equal(lv(raw({ ...base, enabled: false })).level, 'nascosto');
});

test('voto ok con impronta diversa: è cambiata dopo il via', () => {
  const at = T - H;
  const fb = { ...noFb(), vote: { v: 'ok', at: 'x', fp: 'vecchia', note: null, id: 'v1' }, changedSinceVote: true };
  const r = lv(raw({
    everyMs: DAY, last: { at, outcome: 'ok', delivered: 'none', error: null }, runs: [{ at, outcome: 'ok' }],
  }), { fb });
  assert.equal(r.level, 'te');
  assert.match(r.reason, /va bene/);
});

test('consegna fallita su un giornaliero: rotto', () => {
  const at = T - 2 * H;
  const r = lv(raw({
    everyMs: DAY, last: { at, outcome: 'ok', delivered: 'failed', error: null }, runs: [{ at, outcome: 'ok' }],
  }));
  assert.equal(r.level, 'rotto');
  assert.match(r.reason, /non ti è arrivato/);
});

test('va e viene: 10 giri alternati', () => {
  const runs = [];
  for (let i = 0; i < 10; i++) runs.push({ at: T - i * H, outcome: i % 2 ? 'error' : 'ok' });
  const r = lv(raw({
    everyMs: H, last: { at: T, outcome: 'ok', delivered: 'none', error: null }, runs,
  }));
  assert.equal(r.level, 'rotto');
  assert.match(r.reason, /va e viene/);
});

test('in ritardo: ogni ora dopo 4 ore è rotto', () => {
  const at = T - 4 * H;
  const r = lv(raw({
    everyMs: H, last: { at, outcome: 'ok', delivered: 'none', error: null }, runs: [{ at, outcome: 'ok' }],
  }));
  assert.equal(r.level, 'rotto');
  assert.match(r.reason, /non gira da/);
});

test('github in ritardo: 30 ore va, 40 ore è rotto', () => {
  const mk = (ago) => raw({
    provider: 'github', everyMs: DAY, expectedLast: T - ago,
    last: { at: T - ago, outcome: 'ok', delivered: null, error: null }, runs: [{ at: T - ago, outcome: 'ok' }],
  });
  assert.equal(lv(mk(30 * H)).level, 'va');
  assert.equal(lv(mk(40 * H)).level, 'rotto');
});

test('rotta da 8 giorni senza sguardi: serve Attilio; con una nota resta rotta', () => {
  const at = T - 8 * DAY;
  const item8 = raw({
    everyMs: DAY, last: { at, outcome: 'error', delivered: 'none', error: 'boom' },
    runs: [{ at, outcome: 'error' }], consecutiveErrors: 1,
  });
  const alone = lv(item8);
  assert.equal(alone.level, 'te');
  assert.match(alone.reason, /nessuno/);
  const seen = lv(item8, { fb: { ...noFb(), history: [{ id: 'n1', key: 'cron:prova', kind: 'note', note: 'vedo', at: new Date(T - 7 * DAY).toISOString() }] } });
  assert.equal(seen.level, 'rotto');
});

test('domenica alle 3:19 si dice così', () => {
  const r = lv(raw({
    everyMs: 7 * DAY, last: { at: SUN, outcome: 'error', delivered: 'none', error: 'x' },
    runs: [{ at: SUN, outcome: 'error' }], consecutiveErrors: 1,
  }));
  assert.equal(r.reason, 'ha fallito domenica alle 3:19');
});
test('findings: errori al job, rumore a te, battito libero', () => {
  const items = [raw({ key: 'cron:abcdef12-3456' }), raw({ key: 'cron:12345678-abcd' })];
  const { byKey, loose } = fromFindings([
    { kind: 'errori', line: 'posta (abcdef12): 3 errori nelle ultime 24h' },
    { kind: 'rumore', line: 'riepilogo (12345678): consegna spesso, 14 messaggi in 7 giorni' },
    { kind: 'heartbeat', line: "scratch dell'heartbeat a 42 KB" },
  ], items);
  assert.equal(byKey.get('cron:abcdef12-3456').level, 'rotto');
  assert.ok(!byKey.get('cron:abcdef12-3456').reason.includes('(abcdef12)'));
  assert.equal(byKey.get('cron:12345678-abcd').level, 'te');
  assert.match(byKey.get('cron:12345678-abcd').reason, /14 messaggi/);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].title, 'Il battito di Jarvis gira sempre');
});
test('findings del doctor: un avviso va a te, un errore è rotto', () => {
  const { loose } = fromFindings([
    { kind: 'doctor', line: 'doctor warning: core/doctor/browser — cookie import is enabled' },
    { kind: 'doctor', line: 'doctor error: doctor — non leggibile' },
  ], []);
  assert.deepEqual(loose.map((l) => l.level), ['te', 'rotto']);
});

const srcOk = (items) => ({ ok: true, at: T - 60000, items });
const emptySources = () => ({
  openclaw: srcOk([]), launchd: srcOk([]), desktop: srcOk([]),
  workflows: { ok: true, at: T - 60000, items: [], runs: [] },
  github: srcOk([]), pc: srcOk([]),
  counted: { ok: true, at: T - 60000, counts: {} },
});
const mini = (over = {}) => ({
  now: T, sources: emptySources(), descriptions: {}, feedback: new Map(),
  findings: { at: T - H, items: [] }, gateway: { up: true }, proofs: {}, ...over,
});
const healthy = (key, provider, everyMs = DAY, ago = H) => raw({
  key, provider, name: key, everyMs,
  last: { at: T - ago, outcome: 'ok', delivered: 'none', error: null }, runs: [{ at: T - ago, outcome: 'ok' }],
});

test('gateway giù: gli openclaw si nascondono, una causa li spiega', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((n) => healthy(`cron:${n}`, 'openclaw'));
  const m = buildModel(mini({ sources: { ...emptySources(), openclaw: srcOk(items) }, gateway: { up: false } }));
  assert.ok(m.cards['cause:openclaw']);
  assert.equal(m.cards['cause:openclaw'].level, 'rotto');
  assert.ok(m.verdict.hidden >= 5);
  assert.equal(Object.keys(m.cards).filter((k) => k.startsWith('cron:')).length, 0);
});

test('PC che dorme: zero card, nota nel piede', () => {
  const s = emptySources();
  s.pc = { ok: true, asleep: true, at: T - 60000, items: [healthy('pc:notte', 'pc', null, 2 * H)] };
  const m = buildModel(mini({ sources: s }));
  assert.equal(Object.keys(m.cards).filter((k) => k.startsWith('pc:')).length, 0);
  assert.equal(m.footer.pcAsleep, true);
});

test('oggetto con anyOk: basta una fonte buona; senza, vince il peggiore', () => {
  const gh = raw({
    key: 'gh:a/b/c.yml', provider: 'github', name: 'g', everyMs: DAY,
    last: { at: T - 2 * H, outcome: 'error', delivered: null, error: null },
    runs: [{ at: T - 2 * H, outcome: 'error' }], consecutiveErrors: 1,
  });
  const ld = healthy('launchd:com.prova.x', 'launchd');
  const base = {
    'gh:a/b/c.yml': { titolo: 'g', cosa: '', tiScrive: '', group: null, object: 'copia' },
    'launchd:com.prova.x': { titolo: 'l', cosa: '', tiScrive: '', group: null, object: 'copia' },
  };
  const srcs = () => ({ ...emptySources(), github: srcOk([gh]), launchd: srcOk([ld]) });
  const anyOk = buildModel(mini({ sources: srcs(), descriptions: { ...base, 'object:copia': { titolo: 'Copia', cosa: '', tiScrive: '', group: 'dati', anyOk: true } } }));
  assert.equal(anyOk.cards['object:copia'].level, 'va');
  assert.equal(anyOk.cards['object:copia'].sources.length, 2);
  const strict = buildModel(mini({ sources: srcs(), descriptions: { ...base, 'object:copia': { titolo: 'Copia', cosa: '', tiScrive: '', group: 'dati' } } }));
  assert.equal(strict.cards['object:copia'].level, 'rotto');
});

test('silenziata: nascosta e contata nel piede', () => {
  const state = buildState(
    [{ id: 'm1', key: 'cron:rumore', kind: 'mute', until: null, why: 'basta', at: new Date(T - DAY).toISOString(), by: 'operatore', src: 'hub' }],
    { now: T },
  );
  const m = buildModel(mini({ sources: { ...emptySources(), openclaw: srcOk([healthy('cron:rumore', 'openclaw')]) }, feedback: state }));
  assert.equal(m.verdict.hidden, 1);
  assert.equal(m.footer.hidden.count, 1);
  assert.match(m.footer.hidden.why[0].reason, /per sempre/);
});

test('cinque sezioni sempre, i workflow non sono card', () => {
  const wf = raw({
    key: 'workflow:prova', provider: 'workflow', name: 'prova',
    last: { at: T - H, outcome: 'ok', delivered: null, error: null }, runs: [{ at: T - H, outcome: 'ok' }],
  });
  const s = emptySources();
  s.workflows = { ok: true, at: T - 60000, items: [wf], runs: [{ runId: 'w1', name: 'prova', summary: 'ok', status: 'ok', at: T - H, durationMs: 1, agents: 1, phases: [], file: 'w.json' }] };
  const m = buildModel(mini({ sources: s }));
  assert.deepEqual(m.groups.map((g) => g.id), ['arriva', 'dati', 'quote', 'macchine', 'prodotti']);
  assert.ok(!m.cards['workflow:prova']);
  assert.equal(m.workflows.total, 1);
});

test('lobster fermo al cancello: diventa card te', () => {
  const lob = raw({
    key: 'lobster:report', provider: 'lobster', name: 'report',
    last: { at: T - 3 * H, outcome: 'running', delivered: null, error: null }, runs: [],
    waitingApproval: { step: 'via', since: T - 3 * H, token: 't', file: null },
  });
  const s = emptySources();
  s.workflows = { ok: true, at: T - 60000, items: [lob], runs: [] };
  const m = buildModel(mini({ sources: s }));
  assert.equal(m.cards['lobster:report']?.level, 'te');
  assert.deepEqual(m.needsYou.map((c) => c.key), ['lobster:report']);
});

test('fixture model-ok: tutto sano e coerente col codice', () => {
  const file = JSON.parse(fs.readFileSync(new URL('./fixtures/automations/model-ok.json', import.meta.url), 'utf8'));
  assert.equal(file.checkedAt, NOW);
  assert.deepEqual([file.verdict.needsYou, file.verdict.broken, file.verdict.hidden], [0, 0, 0]);
  assert.equal(file.verdict.ok, 20);
  assert.deepEqual(file.groups.map((g) => g.id), ['arriva', 'dati', 'quote', 'macchine', 'prodotti']);
  assert.ok(file.verdict.runsToday >= 400 && file.verdict.runsToday <= 500);
  assert.equal(file.review.unconfirmed.length, 5);
  assert.deepEqual([file.workflows.total, file.workflows.failed], [6, 0]);
  assert.equal(file.footer.pcAsleep, true);
  assert.deepEqual(file, buildOk());
});

test('fixture model-problemi: 2 te, 4 rotte, fusa vista da 4 fonti', () => {
  const file = JSON.parse(fs.readFileSync(new URL('./fixtures/automations/model-problemi.json', import.meta.url), 'utf8'));
  assert.equal(file.checkedAt, NOW);
  assert.deepEqual(file.needsYou.map((c) => c.key), ['desktop:compito-festa', 'lobster:report-lobster']);
  assert.equal(file.broken.length, 4);
  const fused = file.cards['object:copia-sito'];
  assert.equal(fused.level, 'va');
  assert.equal(fused.reason, 'vista da 4 fonti');
  assert.equal(fused.sources.length, 4);
  assert.ok(file.footer.hidden.why.some((w) => w.title === 'Promemoria rumoroso'));
  const gh = file.footer.sources.find((s) => s.name === 'github');
  assert.equal(gh.pending, true);
  assert.equal(gh.note, '?');
  assert.deepEqual([file.workflows.total, file.workflows.failed], [8, 2]);
  assert.ok(file.workflows.byName.every((b) => b.runs.every((r) => Array.isArray(r.phases))));
  assert.deepEqual(file, buildProblemi());
});
