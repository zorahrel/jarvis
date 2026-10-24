import '../test-support/isolate-tmp.mjs';
// Falsi verdi trovati dalla verifica indipendente (23/10): ognuno qui è un'automazione che non va
// e che la scheda mostrava sotto «Funzionano». Se uno torna verde, questo file fa rosso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { levelOf } from '../src/automations/levels.mjs';
import { watchRuns, readLaunchd } from '../src/automations/sources/launchd.mjs';
import { buildModel } from '../src/automations/model.mjs';
import { createPcSource } from '../src/automations/sources/pc.mjs';

const H = 3600000;
const DAY = 24 * H;
const NOW = Date.parse('2026-10-23T16:00:00+02:00');

const launchdJob = (over = {}) => ({
  key: 'launchd:com.prova.ogni15', provider: 'launchd', name: 'com.prova.ogni15', enabled: true,
  everyMs: 15 * 60000, next: null, expectedLast: null,
  last: { at: NOW - 5 * 60000, outcome: 'ok', delivered: null }, runs: [], tech: { exit: 0 }, ...over,
});

test('launchd ogni 15 minuti con exit 1: rotto subito (launchd non dà mai la striscia)', () => {
  const it = launchdJob({ last: { at: NOW - 5 * 60000, outcome: 'error', delivered: null }, tech: { exit: 1 } });
  assert.equal(levelOf(it, { now: NOW }).level, 'rotto');
});

test('prova mancante su un job scaricato: rotto, non «spento»', () => {
  const it = launchdJob({ enabled: false });
  const proof = { ok: false, words: 'manca la prova: nessun commit del backup tra le 04:32 e le 05:30' };
  const r = levelOf(it, { now: NOW, proof });
  assert.equal(r.level, 'rotto');
  assert.match(r.reason, /manca la prova/);
});

test('prova illeggibile: ti aspetta, non verde', () => {
  const r = levelOf(launchdJob(), { now: NOW, proof: { ok: null, words: 'prova non leggibile: not a git repository' } });
  assert.equal(r.level, 'te');
});

test('OpenClaw: prossimo giro scaduto da oltre un\'ora è un giro saltato, anche con espressione a più orari', () => {
  const it = {
    key: 'cron:abc', provider: 'openclaw', enabled: true, everyMs: null, next: NOW - 2 * H, nextApprox: false,
    last: { at: NOW - 30 * H, outcome: 'ok', delivered: 'delivered' }, runs: [], tech: {},
  };
  const r = levelOf(it, { now: NOW });
  assert.equal(r.level, 'rotto');
  assert.match(r.reason, /doveva girare .* e non è partito/);
  assert.equal(levelOf({ ...it, next: NOW + H }, { now: NOW }).level, 'va');
  assert.equal(levelOf({ ...it, next: NOW - 30 * 60000 }, { now: NOW }).level, 'va'); // dentro l'ora di grazia
});

test('launchd con log muto: il contatore fermo oltre un giro e la tolleranza è un giro saltato', () => {
  const memo = new Map();
  const job = () => launchdJob({ last: { at: null, outcome: 'ok', delivered: null, atUnknown: true } });
  const t0 = NOW - 2 * H;
  watchRuns([job()], new Map([['com.prova.ogni15', 40]]), t0, memo);
  const later = job();
  watchRuns([later], new Map([['com.prova.ogni15', 40]]), NOW, memo);
  assert.equal(later.noRunSince, t0);
  // 2 ore ferme su un intervallo di 15 minuti (tolleranza 1 ora): saltato
  assert.equal(levelOf(later, { now: NOW }).level, 'rotto');
  // il contatore si muove: un giro c'è stato, ora approssimata, niente ritardo
  const moved = job();
  watchRuns([moved], new Map([['com.prova.ogni15', 41]]), NOW, memo);
  assert.equal(moved.noRunSince, undefined);
  assert.equal(moved.last.at, NOW);
  assert.equal(moved.last.atApprox, true);
  assert.equal(levelOf(moved, { now: NOW }).level, 'va');
});

test('launchd a calendario: giro atteso dopo l\'inizio dell\'osservazione e contatore fermo → rotto', () => {
  const it = launchdJob({
    everyMs: DAY, expectedLast: NOW - 5 * H, noRunSince: NOW - 20 * H,
    last: { at: null, outcome: 'ok', delivered: null, atUnknown: true },
  });
  assert.equal(levelOf(it, { now: NOW }).level, 'rotto');
  // osservazione iniziata dopo il giro atteso: non si sa, non si accusa
  assert.equal(levelOf({ ...it, noRunSince: NOW - H }, { now: NOW }).level, 'va');
});

test('log fermo senza contatore: nessuna finestra che accende e spegne «non gira»', () => {
  // Il log vale fino alla stessa soglia dei livelli; oltre, l'ora è ignota e decide solo il contatore.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'falsi-verdi-'));
  const log = path.join(dir, 'ogni15.log');
  fs.writeFileSync(path.join(dir, 'com.jarvis.ogni15.plist'), '');
  fs.writeFileSync(log, 'x');
  const plutil = () => ({ Label: 'com.jarvis.ogni15', StartInterval: 900, StandardOutPath: log, ProgramArguments: ['/bin/true'] });
  // 15 minuti: tolleranza un'ora, soglia a 5 giri; la vecchia finestra accesa stava tra 5 e 7 giri.
  for (const k of [4.9, 5.1, 6, 6.9, 7.1, 12]) {
    const t = (NOW - k * 15 * 60000) / 1000;
    fs.utimesSync(log, t, t);
    const { items } = readLaunchd({ dir, launchctlList: '-\t0\tcom.jarvis.ogni15\n', now: NOW, plutil });
    assert.equal(levelOf(items[0], { now: NOW }).level, 'va', `log fermo da ${k} giri`);
  }
  fs.rmSync(dir, { recursive: true });
});

test('cron-health: una riga sul job alza il livello, una riga senza job diventa una card', () => {
  const item = {
    key: 'cron:abcdef12-0000-0000-0000-000000000000', provider: 'openclaw', name: 'prova', enabled: true,
    everyMs: DAY, next: NOW + H, nextApprox: false,
    last: { at: NOW - 2 * H, outcome: 'ok', delivered: 'delivered' }, runs: [], tech: {},
  };
  const m = buildModel({
    now: NOW,
    sources: { openclaw: { ok: true, at: NOW, items: [item] } },
    findings: { at: NOW, items: [{ kind: 'errori', line: 'prova (abcdef12): 3 errori nell\'ultima settimana' }, { kind: 'heartbeat', line: 'heartbeat fermo da 3 ore' }] },
  });
  assert.ok(m.broken.some((c) => c.key === item.key), 'il job segnalato da cron-health non è verde');
  const loose = [...m.broken, ...m.needsYou].find((c) => c.provider === 'health');
  assert.ok(loose, 'la riga senza job ha la sua card');
  assert.equal(loose.key, 'health:heartbeat fermo da 3 ore');
});

test('PC in stato sconosciuto: «?», non «dorme»', async () => {
  const pc = createPcSource({ pcState: async () => ({ pc: 'sconosciuto' }), query: async () => '' });
  await pc.refresh();
  const r = pc.read();
  assert.notEqual(r.asleep, true);
  assert.equal(r.ok, false);
});

test('log su /dev/null: esito di launchctl senza ora, nessun giro inventato nel Diario', async () => {
  // Giro 9: cinque job con StandardOutPath=/dev/null comparivano «riusciti» all'ora di ogni lettura (mtime di /dev/null).
  const { journal } = await import('../src/journal.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'falsi-verdi-'));
  fs.writeFileSync(path.join(dir, 'com.jarvis.muto.plist'), '');
  const plutil = () => ({ Label: 'com.jarvis.muto', StartInterval: 3600, StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null', ProgramArguments: ['/bin/true'] });
  const { items } = readLaunchd({ dir, launchctlList: '-\t0\tcom.jarvis.muto\n', now: NOW, plutil });
  const it = items[0];
  assert.equal(it.last.at, null, 'nessuna ora dal mtime di /dev/null');
  assert.equal(it.last.atUnknown, true);
  assert.equal(it.last.outcome, 'ok', 'l\'exit 0 di launchctl resta l\'ultimo esito');
  assert.deepEqual(it.runs, []);
  const model = buildModel({ now: NOW, sources: { launchd: { ok: true, at: NOW, items } } });
  const rows = journal({ model, now: NOW }).filter((r) => r.ref === 'launchd:com.jarvis.muto');
  assert.deepEqual(rows, [], 'nel Diario nessun giro con un\'ora inventata');
  fs.rmSync(dir, { recursive: true });
});
