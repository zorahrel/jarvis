import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast, simulate, consumedSince, headline } from '../src/forecast.mjs';

const H = 3600000, D = 86400000;
const NOW = Date.parse('2026-10-22T02:30:00+02:00');
// Storico lineare: `perDay` punti percentuali al giorno negli ultimi `days` giorni, fino a `used`.
const hist = (used, perDay, days = 3) => Array.from({ length: days * 24 + 1 }, (_, i) => {
  const ago = (days * 24 - i) * H;
  return { t: (NOW - ago) / 1000, v: Math.max(0, used - (perDay * ago) / D) };
});
const row = (provider, account, used, resetIn, perDay, five = 0) => ({
  provider, account, used, resetsAt: NOW + resetIn, history: hist(used, perDay), last24h: perDay,
  fiveHour: { used: five, resetsAt: NOW + 1.3 * H },
});

test('il consumo conta i reset come ripartenza, non come calo', () => {
  const h = [{ t: 0, v: 90 }, { t: 3600, v: 99 }, { t: 7200, v: 4 }];
  assert.equal(consumedSince(h, 10, 0, 3 * H), 9 + 4 + 6);
});

test('Codex del 22/10: finisce in giornata, buco di giorni fino al reset, eccezione sulla finestra di 5 ore', () => {
  const [c] = forecast([row('codex', 'account-a', 71, 5.2 * D, 37, 100)], { now: NOW });
  assert.equal(c.status, 'corto');
  assert.ok(Math.abs(c.runsOutAt - (NOW + (29 / 37) * D)) < 20 * 60000, 'finisce dopo circa 19 ore');
  assert.match(c.right, /^finisce /);
  assert.match(c.exception.text, /Codex 5 ore piena fino alle/);
});

test('Claude del 22/10: due account come un serbatoio, buco breve tra la fine di operatore e il reset di account-a', () => {
  const rows = [row('claude', 'account-a', 97, 3.3 * D, 13), row('claude', 'operatore', 18, 6.1 * D, 18)];
  const [c] = forecast(rows, { now: NOW });
  assert.equal(c.status, 'stretto');
  const gapH = (c.gapUntil - c.runsOutAt) / H;
  assert.ok(gapH > 6 && gapH < 20, `buco di ${gapH} ore`);
  assert.ok(Math.abs(c.gapUntil - rows[0].resetsAt) <= 600000, 'il buco finisce al reset di account-a');
  assert.equal(c.exception, null, 'niente in barra: il buco è tra giorni');
});

test('un account a secco non abbassa la previsione: conta il ritmo di oggi', () => {
  const r = row('claude', 'a', 18, 6.1 * D, 31);
  r.history = [{ t: (NOW - 3 * D) / 1000, v: 100 }, { t: (NOW - 0.9 * D) / 1000, v: 0 }, ...hist(18, 31, 1).filter((p) => p.t * 1000 > NOW - 0.9 * D)];
  const [c] = forecast([r], { now: NOW });
  assert.ok(c.rate3 < c.rate24, 'la media dei 3 giorni è più bassa perché era a secco');
  assert.equal(c.level, 2, 'decide il ritmo di oggi');
});

test('quota non letta: nessuna previsione inventata', () => {
  const [m] = forecast([{ provider: 'muse', account: 'm', unknown: true }], { now: NOW });
  assert.equal(m.status, 'ignota');
});

test('la frase in cima nomina la cosa più vicina', () => {
  const fc = forecast([row('codex', 'z', 71, 5.2 * D, 37), row('claude', 'account-a', 97, 3.3 * D, 13), row('claude', 'operatore', 18, 6.1 * D, 18)], { now: NOW });
  assert.match(headline(fc, NOW).title, /^Codex finisce/);
});
