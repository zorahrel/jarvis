import test from 'node:test';
import assert from 'node:assert/strict';
import { macMachine, pcMachine } from '../src/machines.mjs';
import { sessionUse } from '../src/session-use.mjs';

test('pcMachine: misure e processi dalla riga di autosleep', () => {
  const m = pcMachine({ pc: 'lavora', perche: 'processo re9 a 9,0 core; cpu 60%; gpu 92%; richiesta di alimentazione: [DRIVER] X', mac: 1, soglia: 1.5, avviso: false }, { name: 'Casa' });
  assert.equal(m.name, 'Casa');
  assert.deepEqual(m.metrics.map((x) => [x.key, x.pct, x.level]), [['cpu', 60, 0], ['gpu', 92, 1]]);
  assert.deepEqual(m.procs, [{ name: 're9', cores: 9 }]);
  assert.equal(m.level, 1);
  assert.ok(!m.lines.join(' ').includes('[DRIVER]'));
});

test('pcMachine: dorme senza misure, avviso se il Mac è carico', () => {
  const m = pcMachine({ pc: 'dorme', perche: '', mac: 2.1, soglia: 1.5, avviso: true });
  assert.equal(m.state, 'dorme');
  assert.equal(m.metrics.length, 0);
  assert.equal(m.level, 1);
  assert.match(m.lines[0], /offload/);
});

test('macMachine: stessa forma del PC, note con le quantità', () => {
  const m = macMachine({ cores: 12, effort: { level: 2, label: 'sotto sforzo', why: 'memoria piena', parts: [{ key: 'cpu', name: 'CPU', pct: 80, level: 0, load: 1.2 }, { key: 'mem', name: 'memoria', pct: 60, level: 2 }] },
    mem: { totalGB: 32, usedGB: 26.4, appGB: 8, wiredGB: 7, compressedGB: 10, cachedGB: 4, freeGB: 1 }, hogs: [{ name: 'node', memMB: 2765 }], paused: [], history: { cpu: [{ t: 1, v: 90 }] } });
  assert.deepEqual(Object.keys(m).sort(), Object.keys(pcMachine({ pc: 'dorme' })).sort());
  assert.equal(m.metrics[0].note, '1,2 in fila/core');
  assert.equal(m.metrics[1].name, 'RAM');
  assert.match(m.lines[0], /^Memoria piena · pesa di più: node 2,7 GB/);
  assert.equal(macMachine({}), null);
});

test('sessionUse: solo il giro attuale, ultima ora a parte, quota solo per Claude', () => {
  const now = 10_000_000;
  const files = new Map([['/a.jsonl', { rows: [[now - 7200000, '', 100, 10, 0, 1000], [now - 600000, '', 200, 20, 50, 0], [now - 60000, '', 1, 1, 0, 0]] }]]);
  const u = sessionUse({ provider: 'claude', file: '/a.jsonl', startedAt: now - 3 * 3600000 }, { claude: { files } }, { now, weekShare: (w) => w / 1000 });
  assert.equal(u.tokens, 110 + 270 + 2);
  assert.equal(u.hourTokens, 270 + 2);
  assert.ok(u.pct > u.hourPct);
  const late = sessionUse({ provider: 'claude', file: '/a.jsonl', startedAt: now - 1000 }, { claude: { files } }, { now });
  assert.equal(late, null);
  const cx = sessionUse({ provider: 'codex', file: '/c', startedAt: 0 }, { codex: { files: new Map([['/c', { rows: [[now, 500, 0, 0, 0]] }]]) } }, { now });
  assert.deepEqual(cx, { tokens: 500, hourTokens: 500, pct: null, hourPct: null });
  assert.equal(sessionUse({ provider: 'claude', startedAt: 0 }, {}), null);
});

test('offload attivo: il PC dice cosa sta facendo, da quanto e per chi', async () => {
  const { pcMachine, offloadJobs } = await import('../src/machines.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: 1, at: 1000, dir: 'usage-hub', cmd: 'npm test', who: 'Claude Code' }));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: 2, at: 2000, dir: 'quadra', cmd: 'pnpm build', who: 'Codex' }));
  fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 3, at: 3000, dir: 'x', cmd: 'y', who: 'z' }));
  const jobs = offloadJobs({ dir, alive: (pid) => pid !== 3 });
  assert.equal(jobs.length, 2, 'il pid morto non conta');
  const m = pcMachine({ pc: 'acceso', perche: 'inattivo da 2 min' }, { jobs, now: 1000 + 12 * 60000 });
  assert.equal(m.state, 'lavora');
  assert.equal(m.offload, 2);
  assert.equal(m.lines[0], 'Sta lavorando: i test di usage-hub · da 12 min · per Claude Code');
  assert.match(m.lines[1], /^Sta lavorando: la build di quadra · da 12 min · per Codex$/);
  const idle = pcMachine({ pc: 'dorme', perche: '' }, { jobs: [] });
  assert.equal(idle.state, 'dorme');
  assert.equal(idle.offload, 0);
});
