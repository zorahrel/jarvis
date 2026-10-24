// Bilanciamento fra account dello stesso abbonamento (24/10): un lavoro nuovo va sull'account con più margine
// rispetto al suo reset, mai su uno che corre oltre il ritmo mentre un altro è in linea.
// Il 21-23/10 VDM svuotava un account alla volta (attilio al 99% col 41% di settimana passato).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPace, gate, carryLastReading } from '../src/pacing.mjs';
import { paceAlerts } from '../src/alerts.mjs';

const NOW = Date.UTC(2026, 9, 24, 0, 30, 0);
const H = 3600000, D = 86400000;
const acc = (label, used, resetIn, { active = false, history } = {}) => ({
  label, active,
  quotas: [{ key: '7d', usedPct: used, resetsAt: (NOW + resetIn) / 1000, ...(history ? { history } : {}) }, { key: '5h', usedPct: 0, resetsAt: (NOW + 2 * H) / 1000 }],
});
const rowsOf = (accounts, extra = []) => buildPace({ providers: [{ id: 'claude', accounts }, ...extra] }, { now: NOW });

// Il caso del 23/10: «corre» si azzera prima ma consuma 1,2 volte il previsto (sotto il freno 1,3 del massivo),
// «libero» ha quasi tutta la settimana davanti. Prima del fix vinceva chi si azzera prima.
const runner = () => acc('corre', 85, 2 * D, { active: true });
const free = () => acc('libero', 5, 6 * D);

for (const cls of ['interattivo', 'gusto', 'massivo', 'batch']) {
  test(`${cls}: non va sull'account oltre il ritmo quando un altro ha margine`, () => {
    const rows = rowsOf([runner(), free()]);
    assert.ok(rows.find((r) => r.account === 'corre').pace > 1, 'la prova vuole un account oltre il ritmo');
    const g = gate(rows, cls, { now: NOW, skip: ['free', 'muse', 'codex'] });
    assert.deepEqual([g.go, g.provider, g.account], [true, 'claude', 'libero']);
  });
}

test('gusto: un account a 1,5 volte il ritmo resta fermo se un altro è in linea, anche se si azzera prima', () => {
  const rows = rowsOf([acc('attilio', 60, 4.1 * D, { active: true }), acc('hi', 14, 4.5 * D)]);
  assert.equal(gate(rows, 'gusto', { now: NOW }).account, 'hi');
});

test('usa-o-perdi: l\'account che si azzera fra poche ore con quota avanzata ha il margine più alto', () => {
  const rows = rowsOf([acc('fresco', 0, 7 * D, { active: true }), acc('scade', 50, 10 * H)]);
  assert.equal(gate(rows, 'gusto', { now: NOW }).account, 'scade');
});

test('isteresi: l\'account attivo resta finché un altro non ha almeno un quarto di margine in più', () => {
  // attivo 14,3%/g contro 16,7%/g dell'altro: +17%, si resta (ogni cambio di account fa perdere la cache dei prompt).
  const near = rowsOf([acc('attivo', 0, 7 * D, { active: true }), acc('altro', 0, 6 * D)]);
  assert.equal(gate(near, 'gusto', { now: NOW }).account, 'attivo');
  // 14,3 contro 20: +40%, si cambia.
  const far = rowsOf([acc('attivo', 0, 7 * D, { active: true }), acc('altro', 0, 5 * D)]);
  assert.equal(gate(far, 'gusto', { now: NOW }).account, 'altro');
});

test('Codex senza lettura: resta nel gate con l\'ultima riga letta, al massimo per due ore', () => {
  const before = buildPace({ providers: [{ id: 'codex', accounts: [acc('codex', 23, 6.5 * D)] }] }, { now: NOW - 10 * 60000 });
  const missing = buildPace({ providers: [{ id: 'codex', error: 'nessun dato' }] }, { now: NOW });
  const carried = carryLastReading(missing, before, { now: NOW });
  const cx = carried.find((r) => r.provider === 'codex');
  assert.deepEqual([cx.used, cx.stale, cx.unknown], [23, true, undefined]);
  // Oltre due ore la riga vecchia non vale più: resta «ignota», non sparisce.
  const late = carryLastReading(missing, before, { now: NOW + 3 * H });
  assert.deepEqual(late.filter((r) => r.provider === 'codex').map((r) => r.status), ['ignota']);
});

test('Codex con errore e nessuna lettura precedente: riga ignota, il gate non lo salta', () => {
  const rows = buildPace({ providers: [{ id: 'codex', error: 'nessun dato' }] }, { now: NOW });
  assert.deepEqual(rows.map((r) => [r.provider, r.status]), [['codex', 'ignota']]);
  assert.equal(gate(rows, 'massivo', { now: NOW, skip: ['free'] }).provider, 'codex');
});

test('avviso solo se un account oltre 2 volte il ritmo sale ancora mentre un altro è in linea', () => {
  const t = (h, v) => ({ t: (NOW - h * H) / 1000, v });
  const climbing = [t(30, 60), t(3, 95), t(2, 96), t(0.1, 99)];
  const rows = rowsOf([acc('attilio', 99, 4.1 * D, { history: climbing }), acc('hi', 14, 1.4 * D, { active: true })]);
  const ev = paceAlerts({ at: NOW, pace: rows });
  assert.deepEqual(ev.map((e) => e.id), ['bypass:claude/attilio']);
  assert.match(ev[0].message, /desktop/);
  // Fermo nelle ultime 2 ore (il bilanciamento l'ha già lasciato): niente avviso.
  const still = rowsOf([acc('attilio', 99, 4.1 * D, { history: [t(30, 60), t(3, 99), t(0.1, 99)] }), acc('hi', 14, 1.4 * D)]);
  assert.deepEqual(paceAlerts({ at: NOW, pace: still }), []);
  // Nessun altro in linea: non c'è dove spostarsi, l'avviso non chiederebbe niente.
  const alone = rowsOf([acc('attilio', 99, 4.1 * D, { history: climbing }), acc('zora', 100, 1.3 * D)]);
  assert.deepEqual(paceAlerts({ at: NOW, pace: alone }).map((e) => e.id).filter((id) => id.startsWith('bypass:')), []);
});
