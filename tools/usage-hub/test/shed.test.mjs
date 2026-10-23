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

const C = (o) => ({ pid: 1, kind: 'sottoagente', priority: 'normale', cls: null, cpu: 2, memMB: 100, project: 'p', ...o });

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

import { createShedDigest } from '../src/shed.mjs';
test('peso altrove: un agente leggero non va in pausa, uno che pesa sì', async () => {
  // il caso del 23/10: Mac a 2,3 per core, agenti quasi fermi, il peso in un server TypeScript e nel gateway
  const light = harness({ cands: [C({ pid: 10, kind: 'codex-exec', cls: 'batch', cpu: 0.05, memMB: 300 }), C({ pid: 20, cpu: 0.4, memMB: 900 })] });
  await light.shed.tick();
  assert.deepEqual(light.sent, [], 'nessun SIGSTOP a chi non pesa');
  assert.match(light.shed.status.note, /pesano poco/);
  // memoria piena: un albero grosso ma fermo non si tocca (SIGSTOP non libera RAM), uno grosso e al lavoro sì
  const { weighs } = await import('../src/shed.mjs');
  const mem = { byLoad: false, byMem: true };
  assert.equal(weighs(C({ cpu: 0.05, memMB: 4000 }), mem), false);
  assert.equal(weighs(C({ cpu: 0.5, memMB: 4000 }), mem), true);
  assert.equal(weighs(C({ cpu: 1.5, memMB: 100 }), mem), false, 'sforzo di memoria: la CPU da sola non basta');
  const heavy = harness({ cands: [C({ pid: 10, kind: 'codex-exec', cls: 'batch', cpu: 0.05 }), C({ pid: 30, kind: 'codex-exec', cls: 'batch', cpu: 2.5 })] });
  heavy.shed.tick && (await heavy.shed.tick());
  assert.equal(heavy.shed.paused.length, 1);
  assert.equal(heavy.shed.paused[0].pid, 30, 'si ferma quello che pesa, non il primo della lista');
});

test('nomi da persona per chi pesa: niente «node 6,6 GB»', async () => {
  const { hogName } = await import('../src/mac.mjs');
  assert.deepEqual(hogName('/opt/homebrew/opt/node/bin/node --max-old-space-size=8192 /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789'), { name: 'gateway OpenClaw', kind: 'gateway' });
  assert.deepEqual(hogName('/opt/homebrew/Cellar/node/26.9.0/bin/node /Users/x/Projects/armonia-agency/armonia-site/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot'), { name: 'server TypeScript di armonia-site', kind: 'tsserver' });
  assert.equal(hogName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome').name, 'Google Chrome');
  assert.equal(hogName('node /Users/x/Projects/viaggi-mcp/src/index.ts').name, 'node viaggi-mcp');
  // un server MCP figlio del gateway MCP porta il suo nome, non «node»; un tsserver dice di chi è
  const { topHogs } = await import('../src/mac.mjs');
  const table = [
    { pid: 1, ppid: 0, cpu: 0, rssKB: 9000, etime: '17-04:00:00', command: 'node /x/node_modules/mcp-hot-gateway/index.mjs' },
    { pid: 2, ppid: 1, cpu: 0, rssKB: 6000000, etime: '14-23:38:17', command: 'node /opt/homebrew/bin/wigolo' },
    { pid: 3, ppid: 0, cpu: 0, rssKB: 1000, etime: '4-19:56:22', command: '/Users/x/.local/bin/claude --resume abc' },
    { pid: 4, ppid: 3, cpu: 0, rssKB: 280000, etime: '4-19:52:21', command: 'node /Users/x/Projects/a/armonia-site/node_modules/typescript/lib/tsserver.js' },
  ];
  const hs = await topHogs(table, 4);
  assert.equal(hs[0].name, 'MCP wigolo'); assert.equal(hs[0].kind, 'mcp'); assert.equal(Math.round(hs[0].ageS / 86400), 15);
  const ts = hs.find((h) => h.kind === 'tsserver');
  assert.equal(ts.owner, 'di una sessione Claude aperta da 5 giorni');
});

// 23/10 23:32 a Roma = 21:32 UTC
const T0 = Date.UTC(2026, 9, 23, 21, 32);
const strained = { strained: true, byLoad: true, byMem: true };
async function episode(d, { minutes, hogs = null, pauses = [] }) {
  for (let m = 0; m <= minutes; m++) await d.tick(strained, T0 + m * 60000);
  for (const p of pauses) d.event(p);
  return d.flush(T0 + (minutes + 11) * 60000);
}

test('episodio vero del 23/10: in cima chi bloccava e perché, poi cosa ho fatto; il server TypeScript si nomina e basta', async () => {
  const sent = [], logs = [];
  let wigolo = 5883; const remounts = [];
  const d = createShedDigest({ send: (x) => sent.push(x), log: (x) => logs.push(x), restartGateway: () => { throw new Error('non va riavviato'); },
    mcpChildren: async () => [{ name: 'wigolo', pid: 9, inFlight: 0, memMB: wigolo }, { name: 'topics-board', pid: 8, inFlight: 0, memMB: 41 }],
    remountMcp: async (n) => { remounts.push(n); wigolo = 184; },
    hogs: async () => [
      { name: 'MCP wigolo', kind: 'mcp', memMB: wigolo, cpu: 0, ageS: 15 * 86400 },
      { name: 'server TypeScript di armonia-site', kind: 'tsserver', memMB: 3037, cpu: 0, owner: 'di una sessione Claude aperta da 5 giorni' },
      { name: 'gateway OpenClaw', kind: 'gateway', memMB: 2929 },
      { name: 'Beeper Desktop', kind: 'app', memMB: 1500 },
    ] });
  const r = await episode(d, { minutes: 28 });
  assert.deepEqual(remounts, ['wigolo'], 'rimontato solo il server oltre soglia, una volta');
  assert.equal(r.push, true);
  assert.equal(r.text, '🔴 Mac bloccato 23:32–00:00 da MCP wigolo 5,7 GB (acceso da 15 giorni), poi server TypeScript di armonia-site 3,0 GB (di una sessione Claude aperta da 5 giorni).\n→ riavviato wigolo (5,7 GB → 0,2 GB).');
  assert.doesNotMatch(r.text, /openclaw-isolated|m-critic|[0-9a-f]{8}/);
  // dopo: in cima il server TypeScript, nominato e mai toccato; lo stesso consiglio una volta al giorno
  const ep2 = async (h) => { for (let m = 0; m <= 15; m++) await d.tick(strained, T0 + (h * 60 + m) * 60000); return d.flush(T0 + (h * 60 + 30) * 60000); };
  const r2 = await ep2(2);
  assert.match(r2.text, /^🔴 Mac bloccato 01:32–01:47 da server TypeScript di armonia-site 3,0 GB \(di una sessione Claude aperta da 5 giorni\)/);
  assert.match(r2.text, /→ riavvia quella sessione, se non ti serve più/);
  assert.equal((await ep2(4)).push, false);
  assert.equal(sent.length, 2); assert.deepEqual(remounts, ['wigolo']);
});

test('rimontaggio MCP: sopra 1,5 GB sì, sotto no, mai con una chiamata in corso, al più uno all\'ora', async () => {
  const run = async (kids, ticks = [0]) => {
    const remounts = [];
    const d = createShedDigest({ mcpChildren: async () => kids, remountMcp: async (n) => { remounts.push(n); }, hogs: async () => [] });
    for (const m of ticks) await d.tick({ strained: false }, T0 + m * 60000);
    return remounts;
  };
  assert.deepEqual(await run([{ name: 'wigolo', pid: 1, inFlight: 0, memMB: 1600 }]), ['wigolo'], 'sopra soglia: rimonta');
  assert.deepEqual(await run([{ name: 'wigolo', pid: 1, inFlight: 0, memMB: 1400 }]), [], 'sotto soglia: non tocca');
  assert.deepEqual(await run([{ name: 'wigolo', pid: 1, inFlight: 1, memMB: 6000 }]), [], 'chiamata in corso: aspetta');
  assert.deepEqual(await run([{ name: 'wigolo', pid: 1, inFlight: 0, memMB: 6000 }], [0, 10, 20, 70]), ['wigolo', 'wigolo'], 'una volta l\'ora');
});

test('gateway OpenClaw oltre 4 GB per 5 minuti: un riavvio sicuro, poi il messaggio lo dice', async () => {
  const sent = []; let restarts = 0;
  let gwMB = 1536;
  const d = createShedDigest({ send: (x) => sent.push(x), restartGateway: () => { restarts++; return true; },
    hogs: async () => [{ name: 'gateway OpenClaw', kind: 'gateway', memMB: gwMB, cpu: 0.3 }],
    offloads: async () => [{ at: T0 + 60000, dir: 'zeno' }] });
  await d.tick({ strained: false }, T0 - 5 * 3600000); gwMB = 6758;
  const r = await episode(d, { minutes: 20, pauses: [
    { type: 'pause', at: T0 + 120000, label: 'zeno · codex-exec' }, { type: 'resume', at: T0 + 180000, label: 'zeno · codex-exec' },
    { type: 'pause', at: T0 + 400000, label: 'zeno · codex-exec' }, { type: 'resume', at: T0 + 500000, label: 'zeno · codex-exec' },
    { type: 'pause', at: T0 + 600000, label: 'jarvis · muse-job' } ] });
  assert.equal(restarts, 1, 'un solo riavvio per episodio (e al più ogni 6 h)');
  assert.equal(r.text, '🔴 Mac bloccato 23:32–23:52 da gateway OpenClaw 6,6 GB (cresciuto da 1,5 GB in 5 h).\n→ gateway OpenClaw: riavvio sicuro chiesto, parte a lavori finiti. 2 lavori in pausa breve, 1 ancora fermo, 1 lavoro pesante spostato sul PC.');
  assert.equal(sent.length, 1);
});

test('episodio che si sistema da solo: niente WhatsApp, solo log; un picco breve non è un episodio', async () => {
  const sent = [], logs = [];
  const d = createShedDigest({ send: (x) => sent.push(x), log: (x) => logs.push(x), hogs: async () => [{ name: 'Codex', kind: 'agente', memMB: 900 }] });
  const r = await episode(d, { minutes: 15, pauses: [{ type: 'pause', at: T0, label: 'zeno · codex-exec' }, { type: 'resume', at: T0 + 90000, label: 'zeno · codex-exec' }] });
  assert.equal(r.push, false); assert.equal(sent.length, 0);
  assert.match(logs.at(-1), /^🔴 Mac bloccato 23:32–23:47 da Codex 0,9 GB\. 1 lavoro in pausa breve\.$/);
  assert.equal(d.recent.length, 1);
  const d2 = createShedDigest({ send: (x) => sent.push(x), hogs: async () => [{ name: 'Google Chrome', kind: 'app', memMB: 5000 }] });
  assert.equal(await episode(d2, { minutes: 4 }), null);
  assert.equal(sent.length, 0);
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
