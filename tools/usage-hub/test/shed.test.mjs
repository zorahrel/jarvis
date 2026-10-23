import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strain, swapVerdict, parsePs, classify, descendants } from '../src/mac.mjs';
import { createShed, eligible, rank } from '../src/shed.mjs';
import { attachResources } from '../src/macwatch.mjs';

const mac = (load, cores = 12) => ({ at: 0, cores, load1: load * cores, loadPerCore: load });

test('soglie: 1,5 per core come offload, swap sostenuta come Topics', () => {
  assert.equal(strain(mac(1.2), { sustained: false }).strained, false);
  assert.equal(strain(mac(1.2), { sustained: false }).calm, true);
  const s = strain(mac(2.3), { sustained: false });
  assert.equal(s.strained, true);
  assert.match(s.reason, /Mac a 2,3 per core/);
  const m = strain(mac(0.5), { sustained: true, pagesReadBackPerS: 80 });
  assert.equal(m.strained, true); assert.match(m.reason, /memoria sotto pressione/);
  assert.equal(m.calm, false);
});

test('swap sostenuta: pagine rilette ≥ 10/s con debito ≥ 0,5 GB/min, oppure ≥ 200/s', () => {
  const base = { swapins: 1000, compressorPages: 0, swapUsedMB: 1000, pageSize: 16384 };
  const at = (swapins, comp, swap, t) => ({ ...base, swapins, compressorPages: comp, swapUsedMB: swap, at: t });
  const run = (last) => swapVerdict([at(1000, 0, 1000, 0), last], 61000);
  assert.equal(run(at(1000 + 61 * 12, 40000, 1000, 61000)).sustained, true);   // 12/s, debito ~0,64 GB in 61 s
  assert.equal(run(at(1000 + 61 * 12, 0, 1000, 61000)).sustained, false);       // legge ma non accumula debito
  assert.equal(run(at(1000 + 61 * 250, 0, 1000, 61000)).sustained, true);       // oltre 200/s basta
  assert.equal(run(at(1000 + 61 * 5, 99999, 9999, 61000)).sustained, false);    // sotto 10/s mai
});

const C = (o) => ({ pid: 1, kind: 'sottoagente', priority: 'normale', cls: null, memMB: 100, project: 'p', ...o });

test('chi si può fermare: interattivi e priorità alta mai; ordine bassa → normale, batch → massivo', () => {
  assert.equal(eligible(C({ kind: 'interattivo' })), false);
  assert.equal(eligible(C({ kind: 'altro' })), false);
  assert.equal(eligible(C({ priority: 'alta' })), false);
  assert.equal(eligible(C({})), true);
  const order = rank([
    C({ pid: 1, kind: 'interattivo', priority: 'bassa' }),
    C({ pid: 2, priority: 'alta' }),
    C({ pid: 3, priority: 'normale', cls: 'batch', kind: 'codex-exec', memMB: 900 }),
    C({ pid: 4, priority: 'bassa', cls: 'massivo', kind: 'muse-job' }),
    C({ pid: 5, priority: 'bassa', cls: 'batch', kind: 'codex-exec' }),
    C({ pid: 6, priority: 'bassa', cls: 'batch', kind: 'codex-exec', memMB: 500 }),
  ]).map((c) => c.pid);
  assert.deepEqual(order, [6, 5, 4, 3]);
});

function harness({ load = 2.3, cands, startAt = 1_000_000 } = {}) {
  let t = startAt, loadNow = load, psOk = true; const sent = [];
  const table = [{ pid: 10, ppid: 1, cpu: 0, rssKB: 1, etime: '1', command: 'x' }, { pid: 11, ppid: 10, cpu: 0, rssKB: 1, etime: '1', command: 'y' }];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-')), 'paused.json');
  const notes = [];
  const shed = createShed({
    file, now: () => t, notify: (l) => notes.push(l), signal: (pid, sg) => sent.push(`${sg}:${pid}`),
    probe: { maxLoad: 1.5, mac: async () => mac(loadNow), verdict: () => ({ sustained: false }), strain, table: async () => (psOk ? table : []), startTime: async () => (psOk ? 'T0' : ''),
      tree: () => [10, 11], candidates: async () => cands },
  });
  return { shed, sent, notes, advance: (ms) => { t += ms; }, setLoad: (l) => { loadNow = l; }, setPs: (ok) => { psOk = ok; } };
}

test('sotto sforzo ferma il primo della lista; poi riprende quando il Mac respira', async () => {
  const h = harness({ cands: [C({ pid: 10, kind: 'codex-exec', priority: 'bassa', cls: 'batch', project: 'zeno' })] });
  await h.shed.tick();
  assert.deepEqual(h.sent, ['SIGSTOP:10', 'SIGSTOP:11']);
  assert.match(h.notes[0], /in pausa: Mac a 2,3 per core, riprende sotto 1,5/);
  h.advance(30000); h.setLoad(0.9); await h.shed.tick();
  assert.equal(h.shed.paused.length, 1, 'non riprende prima di un minuto, per non rimbalzare');
  h.advance(40000); await h.shed.tick();
  assert.equal(h.shed.paused.length, 0);
  assert.deepEqual(h.sent.slice(2), ['SIGCONT:11', 'SIGCONT:10']);
  assert.match(h.notes[1], /ripreso: zeno/);
});

test('il limite di 2 minuti riprende anche se il Mac resta carico; una pausa per volta', async () => {
  const h = harness({ cands: [C({ pid: 10, priority: 'bassa' }), C({ pid: 20, priority: 'normale' })] });
  await h.shed.tick();
  h.advance(30000); await h.shed.tick();
  assert.equal(h.sent.filter((s) => s.startsWith('SIGSTOP')).length, 2, 'la seconda pausa aspetta i 120 s di distanza');
  h.advance(100000); await h.shed.tick();
  assert.ok(h.sent.some((s) => s === 'SIGCONT:10'), 'dopo 2 minuti riprende');
});

test('solo sessioni interattive o priorità alta: nessun segnale, solo l\'avviso', async () => {
  const h = harness({ cands: [C({ pid: 10, kind: 'interattivo', priority: 'bassa' }), C({ pid: 20, priority: 'alta' })] });
  await h.shed.tick();
  assert.deepEqual(h.sent, []);
  assert.match(h.shed.status.note, /solo avviso/);
});

test('Mac che respira: niente pause', async () => {
  const h = harness({ load: 0.8, cands: [C({ pid: 10, priority: 'bassa' })] });
  await h.shed.tick();
  assert.deepEqual(h.sent, []);
});

test('all\'avvio riprende quel che il registro dice fermo', async () => {
  const h = harness({ cands: [C({ pid: 10, priority: 'bassa' })] });
  await h.shed.tick();
  h.sent.length = 0;
  await h.shed.thawAll('avvio');
  assert.deepEqual(h.sent, ['SIGCONT:11', 'SIGCONT:10']);
  assert.equal(h.shed.paused.length, 0);
});

test('ps che non risponde sotto sforzo: chi è in pausa resta nel registro e riparte quando ps torna', async () => {
  const h = harness({ cands: [C({ pid: 10, priority: 'bassa' })] });
  await h.shed.tick();
  h.setPs(false); h.advance(130000); await h.shed.tick();
  assert.equal(h.shed.paused.length, 1, 'una tabella vuota non vuol dire processo sparito');
  h.setPs(true); await h.shed.tick();
  assert.deepEqual(h.sent.filter((x) => x.startsWith('SIGCONT')), ['SIGCONT:11', 'SIGCONT:10']);
});

test('all\'avvio, ps muto sull\'ora di partenza: si riprende lo stesso', async () => {
  const h = harness({ cands: [C({ pid: 10, priority: 'bassa' })] });
  await h.shed.tick();
  h.setPs(false); await h.shed.thawAll('avvio');
  assert.deepEqual(h.sent.filter((x) => x.startsWith('SIGCONT')), ['SIGCONT:11', 'SIGCONT:10']);
});

test('classificazione dei processi e risorse per agente', () => {
  const ps = parsePs([
    '  10     1  0.0  1000 01:00 /Users/x/.local/bin/claude --strict-mcp-config --mcp-config /Users/x/.openclaw/tmp/openclaw-cli-mcp-AbC/mcp.json',
    '  11     1  2.0  2000 01:00 /Users/x/.local/bin/claude --model opus',
    '  12    11 50.0  5000 01:00 node /tmp/server.js',
    '  13     1  1.0   300 01:00 /usr/bin/codex exec fai cose',
  ].join('\n'));
  assert.deepEqual(ps.map(classify), ['sottoagente', 'interattivo', 'altro', 'codex-exec']);
  assert.deepEqual(descendants(ps, 11).map((r) => r.pid).sort(), [11, 12]);
  const agents = attachResources([{ project: 'a', provider: 'claude' }, { project: 'b', provider: 'claude' }, { project: 'b', provider: 'claude' }],
    [{ project: 'a', kind: 'interattivo', cpu: 0.5, memMB: 800 }, { project: 'b', kind: 'interattivo', cpu: 0.2, memMB: 100 }, { project: 'b', kind: 'interattivo', cpu: 0.3, memMB: 200 }]);
  assert.deepEqual(agents[0].res, { cpu: 0.5, memMB: 800 });
  assert.equal(agents[1].res.shared, 2);
  assert.equal(agents[1].res.memMB, 300);
});

test('riassunto: un messaggio per episodio, niente sotto 3 pause', async () => {
  const { createShedDigest } = await import('../src/shed.mjs');
  let t = 0; const sent = [];
  const d = createShedDigest({ send: (x) => sent.push(x), now: () => t, hogs: async () => [{ name: 'Chrome', memMB: 3200 }] });
  const L = 'openclaw/sottoagenti · sottoagente';
  for (let i = 0; i < 5; i++) d.event({ type: 'pause', at: i * 60000, label: L, reason: i % 2 ? 'memoria sotto pressione' : 'Mac a 2,7 per core' });
  for (let i = 0; i < 5; i++) d.event({ type: 'resume', at: i * 60000 + 30000, label: L });
  t = 5 * 60000; assert.equal(await d.flush(), null); // episodio ancora aperto
  t = 20 * 60000; const msg = await d.flush();
  assert.equal(sent.length, 1);
  assert.match(msg, /5 volte i sottoagenti di OpenClaw/);
  assert.match(msg, /processore al limite e memoria piena|memoria piena e processore al limite/);
  assert.match(msg, /Chrome 3,1 GB/);
  assert.match(msg, /tutto ripartito/);
  d.event({ type: 'pause', at: t, label: L, reason: 'x' }); t += 30 * 60000;
  assert.equal(await d.flush(), null); assert.equal(sent.length, 1); // una pausa sola: niente messaggio
});

import { effort } from '../src/mac.mjs';
test('sforzo: un solo livello, guidato dalla componente più vicina alla sua soglia', () => {
  const calm = effort({ loadPerCore: 0.3 }, { sustained: false }, { memPressurePct: 40, gpuPct: 10, diskUsedPct: 30 });
  assert.equal(calm.level, 0); assert.equal(calm.label, 'tranquillo'); assert.equal(calm.why, '');
  const gpu = effort({ loadPerCore: 0.3 }, { sustained: false }, { memPressurePct: 40, gpuPct: 85, diskUsedPct: 30 });
  assert.equal(gpu.level, 1); assert.equal(gpu.driver, 'gpu'); assert.equal(gpu.why, 'GPU al 85%');
  const swap = effort({ loadPerCore: 0.3 }, { sustained: true }, { memPressurePct: 50 });
  assert.equal(swap.level, 2); assert.equal(swap.driver, 'mem'); assert.match(swap.why, /swap/);
  const cpu = effort({ loadPerCore: 1.6 }, { sustained: false }, { cpuPct: 60 });
  assert.equal(cpu.level, 2); assert.equal(cpu.driver, 'cpu'); assert.match(cpu.why, /1,6 per core/); assert.equal(cpu.parts[0].byLoad, true);
  const full = effort({ loadPerCore: 0.5 }, { sustained: false }, { cpuPct: 98 });
  assert.equal(full.level, 2); assert.equal(full.why, 'CPU al 98%');
  assert.equal(effort(null, null, {}).level, 0);
});

test('figli del gateway OpenClaw: in pausa solo un sottoagente riconosciuto, mai un turno di chat o uno sconosciuto', async () => {
  const { openclawKind, cliSessionId } = await import('../src/mac.mjs');
  const cmd = (flag, id) => `/Users/x/.local/bin/claude --mcp-config /Users/x/.openclaw/tmp/openclaw-cli-mcp-Ab/mcp.json --print ${flag} ${id} --model opus`;
  const idChat = '39fe224f-b5d9-46ff-b34d-48abed2ce514', idSub = '2602bb84-42f4-4279-bae3-d315f2a64804', idNew = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const resolve = (id) => ({ [idChat]: 'openclaw/whatsapp-diretta', [idSub]: 'openclaw/sub:Zeno pilota' }[id] || 'openclaw/altro');
  assert.equal(cliSessionId(cmd('--resume', idChat)), idChat);
  assert.equal(openclawKind({ command: cmd('--resume', idChat) }, resolve), 'chat-openclaw', 'la chat WhatsApp non va in pausa');
  assert.equal(openclawKind({ command: cmd('--session-id', idSub) }, resolve), 'sottoagente');
  assert.equal(openclawKind({ command: cmd('--session-id', idNew) }, resolve), 'chat-openclaw', 'sconosciuto: non si tocca');
  assert.equal(openclawKind({ command: cmd('--session-id', idSub) }, null), 'chat-openclaw', 'senza indice: non si tocca');
  assert.equal(openclawKind({ command: cmd('', '') }, resolve), 'chat-openclaw');
});
