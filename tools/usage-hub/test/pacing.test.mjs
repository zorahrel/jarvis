import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPace, gate, paceOkAt, providerStates } from '../src/pacing.mjs';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const H = 3600000, D = 86400000;
const acc = (label, used, resetIn, five = 0, active = false) => ({
  label, active,
  quotas: [{ key: '7d', usedPct: used, resetsAt: (NOW + resetIn) / 1000 }, { key: '5h', usedPct: five, resetsAt: (NOW + 2 * H) / 1000 }],
});
// Il 18/10 vero: account-b esaurito (reset mer), account-a fresco, Codex veloce, Muse quasi finito ma reset stanotte.
const overview = {
  providers: [
    { id: 'claude', accounts: [acc('account-b', 100, 2.75 * D), acc('account-a', 3, 6.9 * D, 10, true)] },
    { id: 'codex', accounts: [acc('codex', 18, 6.5 * D)] },
    { id: 'muse', accounts: [acc('muse', 96, 14 * H)] },
  ],
};

test('ritmo e budget giornaliero', () => {
  const rows = buildPace(overview, { now: NOW });
  const codex = rows.find((r) => r.provider === 'codex');
  assert.equal(codex.status, 'veloce'); // 18% su 7% di settimana
  assert.ok(codex.pace > 2);
  assert.equal(rows.find((r) => r.account === 'account-b').status, 'esaurito');
  assert.equal(rows.find((r) => r.account === 'account-a').pace, null); // primo giorno: ritmo muto
  assert.equal(rows.find((r) => r.provider === 'muse').status, 'ok'); // 96% al 92% della settimana
});

test('massivo e batch partono dal gratis', () => {
  const rows = buildPace(overview, { now: NOW });
  assert.equal(gate(rows, 'massivo', { now: NOW }).provider, 'free');
  assert.equal(gate(rows, 'batch', { now: NOW }).provider, 'free');
});

test('senza gratis: Muse all\'ultimo giorno si spende, Codex veloce salta', () => {
  const rows = buildPace(overview, { now: NOW });
  const g = gate(rows, 'batch', { now: NOW, skip: ['free'] });
  assert.deepEqual([g.provider, g.account], ['muse', 'muse']); // 96% ma reset fra 14 ore
  const noFree = gate(rows.filter((r) => r.provider !== 'muse'), 'batch', { now: NOW, skip: ['free'] });
  // Codex al ritmo 2,6 non prende il differibile: tocca a Claude account-a
  assert.equal(noFree.provider, 'claude');
  assert.equal(noFree.account, 'account-a');
});

test('gusto va su Claude e salta l\'account esaurito', () => {
  const g = gate(buildPace(overview, { now: NOW }), 'gusto', { now: NOW });
  assert.deepEqual([g.go, g.provider, g.account], [true, 'claude', 'account-a']);
});

test('dentro un provider prima l\'account che si resetta prima', () => {
  const ov = { providers: [{ id: 'claude', accounts: [acc('tardi', 20, 6 * D), acc('presto', 40, 2 * D)] }] };
  assert.equal(gate(buildPace(ov, { now: NOW }), 'gusto', { now: NOW }).account, 'presto');
});

test('riserva 10%: solo l\'interattivo scende sotto', () => {
  const ov = { providers: [{ id: 'claude', accounts: [acc('ultimo', 91, 3 * D)] }] };
  const rows = buildPace(ov, { now: NOW });
  const g = gate(rows, 'gusto', { now: NOW });
  assert.equal(g.go, false);
  assert.match(g.reason, /riserva 10%/);
  assert.equal(g.waitUntil, NOW + 3 * D);
  assert.equal(gate(rows, 'interattivo', { now: NOW }).go, true);
});

test('finestra 5h piena: aspetta il suo reset, non quello settimanale', () => {
  const ov = { providers: [{ id: 'claude', accounts: [acc('pieno5h', 30, 4 * D, 97)] }] };
  const g = gate(buildPace(ov, { now: NOW }), 'interattivo', { now: NOW });
  assert.equal(g.go, false);
  assert.equal(g.waitUntil, NOW + 2 * H);
});

test('il batch su un provider veloce aspetta finché il ritmo torna a 1', () => {
  const ov = { providers: [{ id: 'codex', accounts: [acc('codex', 50, 5 * D)] }] }; // 50% al 29% di settimana
  const rows = buildPace(ov, { now: NOW });
  const g = gate(rows, 'batch', { now: NOW, skip: ['free'] });
  assert.equal(g.go, false);
  assert.equal(g.waitUntil, paceOkAt(rows[0]));
  assert.equal(new Date(g.waitUntil).toISOString(), new Date(NOW + 5 * D - 7 * D + 3.5 * D).toISOString());
});

test('avvisi di ritmo: solo esaurito in anticipo; Codex veloce tace (lo gestisce il gate), Muse escluso', async () => {
  const { paceAlerts } = await import('../src/alerts.mjs');
  const ev = paceAlerts({ at: NOW, pace: buildPace(overview, { now: NOW }) });
  assert.deepEqual(ev.map((e) => e.id).sort(), ['empty:claude/account-b']);
});

test('--provider: chiede solo per quel provider', () => {
  const rows = buildPace(overview, { now: NOW });
  const codex = gate(rows, 'massivo', { now: NOW, provider: 'codex' });
  assert.equal(codex.go, false); // ritmo 2,6
  assert.match(codex.reason, /codex\/codex: consuma 2,\d+ volte/);
  const muse = gate(rows, 'massivo', { now: NOW, provider: 'muse' });
  assert.deepEqual([muse.go, muse.provider], [true, 'muse']);
});

// Freno sul giorno: il 18/10 account-a ha bruciato 23% in ~8 ore a inizio settimana.
const withHistory = (used, resetIn, samples) => ({
  label: 'z', active: true,
  quotas: [{ key: '7d', usedPct: used, resetsAt: (NOW + resetIn) / 1000, history: samples.map(([agoH, v]) => ({ t: (NOW - agoH * H) / 1000, v })) }],
});
const burn = { providers: [{ id: 'claude', accounts: [withHistory(50, 3 * D, [[30, 27], [8, 27], [4, 38], [0, 50]])] }] };

test('consumo di oggi sopra la quota giornaliera: il differibile si ferma, interattivo no', () => {
  const rows = buildPace(burn, { now: NOW });
  assert.equal(rows[0].last24h, 23);
  assert.ok(rows[0].perDay < 23 && rows[0].pace < 1); // il ritmo settimanale è in regola: ferma solo il giorno
  for (const cls of ['massivo', 'batch']) {
    const g = gate(rows, cls, { now: NOW, skip: ['free'] });
    assert.equal(g.go, false);
    assert.match(g.reason, /ultime 24h 23%/);
    assert.ok(g.waitUntil > NOW);
  }
  assert.equal(gate(rows, 'interattivo', { now: NOW }).go, true);
});

test('il gusto si ferma solo per i progetti a priorità bassa', () => {
  const rows = buildPace(burn, { now: NOW });
  assert.equal(gate(rows, 'gusto', { now: NOW }).go, true);
  assert.equal(gate(rows, 'gusto', { now: NOW, project: { name: 'x', priority: 'normale' } }).go, true);
  assert.equal(gate(rows, 'gusto', { now: NOW, project: { name: 'x', priority: 'bassa' } }).go, false);
});

test('consumo di oggi dentro la quota: passa; reset settimanale: il campione vecchio non conta', () => {
  const calm = { providers: [{ id: 'claude', accounts: [withHistory(50, 3 * D, [[30, 40], [0, 50]])] }] };
  assert.equal(gate(buildPace(calm, { now: NOW }), 'batch', { now: NOW, skip: ['free'] }).go, true);
  // 80 prima del reset, 5 adesso: consumo reale 5, non negativo
  const reset = { providers: [{ id: 'claude', accounts: [withHistory(5, 6.5 * D, [[30, 80], [0, 5]])] }] };
  assert.equal(buildPace(reset, { now: NOW })[0].last24h, 5);
});

test('senza storico il freno del giorno non scatta', () => {
  const rows = buildPace({ providers: [{ id: 'claude', accounts: [acc('z', 50, 3 * D)] }] }, { now: NOW });
  assert.equal(rows[0].last24h, null);
  assert.equal(gate(rows, 'batch', { now: NOW, skip: ['free'] }).go, true);
});

test('stato per abbonamento e per progetto: una sola fonte', async () => {
  const { providerStates, projectState } = await import('../src/pacing.mjs');
  const rows = buildPace(burn, { now: NOW });
  assert.equal(providerStates(rows, { now: NOW }).claude.state, 'frenato');
  assert.match(providerStates(rows, { now: NOW }).claude.reason, /ultime 24h/);
  const calm = buildPace({ providers: [{ id: 'claude', accounts: [withHistory(50, 3 * D, [[30, 40], [0, 50]])] }] }, { now: NOW });
  assert.equal(providerStates(calm, { now: NOW }).claude.state, 'libero');
  const p = { name: 'x', total: 3, priority: 'normale', budgetPct: 10, claude: 12 };
  assert.equal(projectState(calm, p, [], { now: NOW }).state, 'frenato'); // budget finito
  assert.equal(projectState(calm, { ...p, budgetPct: null }, [{ project: 'x', status: 'queued' }], { now: NOW }).state, 'in coda');
  assert.equal(projectState(calm, { ...p, budgetPct: null }, [], { now: NOW }).state, 'attivo');
  assert.equal(projectState(calm, { ...p, budgetPct: null, total: 0 }, [], { now: NOW }).state, 'fermo');
  assert.equal(providerStates(buildPace({ providers: [{ id: 'muse', accounts: [acc('m', 100, 2 * D)] }] }, { now: NOW }), { now: NOW }).muse.state, 'esaurito');
});

test('frenato: ogni account dice perché e a quale condizione riparte', () => {
  const ov = { providers: [{ id: 'claude', accounts: [acc('pieno', 97, 3 * D), acc('veloce', 40, 6 * D)] }] };
  const st = providerStates(buildPace(ov, { now: NOW }), { now: NOW }).claude;
  assert.equal(st.state, 'frenato');
  const by = Object.fromEntries(st.accounts.map((w) => [w.account, w]));
  assert.equal(by.pieno.kind, 'riserva');
  assert.equal(by.pieno.until, NOW + 3 * D);
  assert.equal(by.veloce.kind, 'ritmo');
  assert.equal(by.veloce.target, 40);
});

test('quota non letta: l\'abbonamento resta usabile, non sparisce', () => {
  const ov = { providers: [{ id: 'muse', accounts: [{ label: 'm', active: true, quotas: [] }] }] };
  const rows = buildPace(ov, { now: NOW });
  assert.equal(rows[0].unknown, true);
  const g = gate(rows, 'batch', { now: NOW, skip: ['free'] });
  assert.equal(g.go, true);
  assert.equal(g.provider, 'muse');
});

test('settimana letta ma senza ora di reset: riga ignota, non sparisce', () => {
  const ov = { providers: [{ id: 'muse', accounts: [{ label: 'm', active: true, quotas: [{ key: '7d', usedPct: 28 }] }] }] };
  assert.equal(buildPace(ov, { now: NOW })[0].unknown, true);
});
