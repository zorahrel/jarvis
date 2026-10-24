import '../test-support/isolate-tmp.mjs';
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
  assert.match(m.lines[0], /lo svegliano da soli/);
});

test('macMachine: stessa forma del PC, note con le quantità', () => {
  const m = macMachine({ cores: 12, effort: { level: 2, label: 'sotto sforzo', why: 'memoria piena', parts: [{ key: 'cpu', name: 'CPU', pct: 80, level: 0, load: 1.2 }, { key: 'mem', name: 'memoria', pct: 60, level: 2 }] },
    mem: { totalGB: 32, usedGB: 26.4, appGB: 8, wiredGB: 7, compressedGB: 10, cachedGB: 4, freeGB: 1 }, hogs: [{ name: 'node', memMB: 2765 }], paused: [], history: { cpu: [{ t: 1, v: 90 }] } });
  assert.deepEqual(Object.keys(m).sort(), Object.keys(pcMachine({ pc: 'dorme' })).sort());
  assert.equal(m.metrics[0].note, '1,2 in fila/core');
  assert.equal(m.metrics[1].name, 'Memoria');
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
  // un inizio stimato troppo tardi (coda del file) non taglia il giro: l'inizio vero viene dalle righe, il buco di 2 ore lo chiude
  const late = sessionUse({ provider: 'claude', file: '/a.jsonl', startedAt: now - 1000 }, { claude: { files } }, { now });
  assert.equal(late.tokens, 270 + 2); assert.equal(late.startedAt, now - 600000);
  const cx = sessionUse({ provider: 'codex', file: '/c', startedAt: 0 }, { codex: { files: new Map([['/c', { rows: [[now, 500, 0, 0, 0]] }]]) } }, { now });
  assert.deepEqual(cx, { tokens: 500, hourTokens: 500, pct: null, hourPct: null, startedAt: now, weighted: 0 });
  assert.equal(sessionUse({ provider: 'claude', startedAt: 0 }, {}), null);
});

test('offload attivo: il PC dice cosa sta facendo, da quanto e per chi', async () => {
  const { pcMachine, offloadJobs } = await import('../src/machines.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: 1, at: 1000, dir: 'usage-hub', cmd: 'npm test', who: 'Claude Code' }));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: 2, at: 2000, dir: 'quadra', cmd: 'pnpm build', who: 'Codex' }));
  fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 3, at: 3000, dir: 'x', cmd: 'y', who: 'z' }));
  fs.writeFileSync(path.join(dir, '4.json'), JSON.stringify({ pid: 4, at: 4000, dir: 'prova-pc', cmd: 'ping -n 400 127.0.0.1 >nul && echo fatto', who: 'terminale' }));
  const jobs = offloadJobs({ dir, alive: (pid) => pid !== 3 });
  assert.equal(jobs.length, 3, 'il pid morto non conta');
  jobs[0].title = 'Tray UI';
  const m = pcMachine({ pc: 'acceso', perche: 'inattivo da 2 min' }, { jobs, now: 1000 + 12 * 60000 });
  assert.equal(m.state, 'lavora');
  assert.equal(m.offload, 3);
  assert.equal(m.lines[0], 'I test di usage-hub per «Tray UI», da 12 minuti');
  assert.equal(m.lines[1], 'La build di quadra per Codex, da 12 minuti');
  assert.equal(m.lines[2], 'Un lavoro in prova-pc per un terminale, da 12 minuti', 'mai il comando grezzo');
  const own = pcMachine({ pc: 'acceso' }, { jobs: [{ ...jobs[2], what: 'una prova di rete' }], now: 4000 });
  assert.equal(own.lines[0], 'Una prova di rete per un terminale, da meno di un minuto');
  const idle = pcMachine({ pc: 'dorme', perche: '' }, { jobs: [] });
  assert.equal(idle.state, 'dorme');
  assert.equal(idle.offload, 0);
});

test('pcWhy: ogni motivo di wf-autosleep diventa una frase, mai il testo grezzo', async () => {
  const { pcWhy } = await import('../src/machines.mjs');
  assert.deepEqual(pcWhy('ssh attivo (2 sessioni); stream porta 47989; processo node a 2.1 core; cpu 40%; gpu 30%; encoder 9% (stream); richiesta di alimentazione: [PROCESS] \\Device\\HarddiskVolume3\\Program Files\\OBS\\obs64.exe'),
    ['Collegato dal Mac (2 connessioni)', 'Sta trasmettendo lo schermo', 'Il programma più pesante è Node, 2,1 core', 'OBS lo tiene sveglio']);
  assert.deepEqual(pcWhy('sospensione (inattivo da 20 min)'), ['Si sta addormentando: senza lavoro da 20 minuti']);
  assert.deepEqual(pcWhy('inattivo da 7 min (soglia 20; ultimo input 12:40)'), ['Senza lavoro da 7 minuti: dorme fra 13']);
  assert.deepEqual(pcWhy('richiesta di alimentazione: [DRIVER] NVIDIA High Definition Audio (HDAUDIO\\FUNC_01&VEN_10DE\\5&1037f640)'), ['Il driver NVIDIA High Definition Audio lo tiene sveglio']);
  assert.deepEqual(pcWhy('qualcosa di nuovo e strano'), [], 'quello che non si sa dire non si mostra grezzo');
});

test('macMachine: lo swap è una misura sua e diventa rossa quasi piena; la memoria è la pressione, non i GB occupati', async () => {
  const { macMachine } = await import('../src/machines.mjs');
  const m = macMachine({ cores: 12, effort: { level: 2, label: 'sotto sforzo', why: '', parts: [{ key: 'cpu', name: 'CPU', pct: 67, level: 2, load: 2.5 }, { key: 'mem', name: 'memoria', pct: 51, level: 2 }] },
    mem: { totalGB: 32, usedGB: 28, appGB: 12, wiredGB: 7, compressedGB: 8, cachedGB: 3, freeGB: 1 }, swapUsedGB: 15.1, swapTotalGB: 16, swapSustained: true, hogs: [] });
  assert.deepEqual(m.metrics.map((x) => [x.key, x.name, x.level]), [['cpu', 'CPU', 2], ['mem', 'Memoria', 2], ['swap', 'Swap', 2]]);
  assert.equal(m.metrics[2].value, '15,1/16 GB');
  assert.ok(!m.metrics[1].note.includes('di 32'), 'non i GB occupati');
});
