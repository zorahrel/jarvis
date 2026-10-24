// Strategia margin (24/10): l'account con più quota settimanale per giorno fino al reset.
// Con reset-first VDM svuotava un account alla volta: attilio al 99% col 41% di settimana passato (21-23/10).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStateManager, pickMostMargin, pickByStrategy, weeklyMargin, ROTATION_STRATEGIES } from '../lib.mjs';

const NOW = Date.UTC(2026, 9, 24, 0, 30, 0);
const S = Math.floor(NOW / 1000), D = 86400, H = 3600;
const accounts = [
  { name: 'corre', token: 'tokA', expiresAt: 0 },
  { name: 'libero', token: 'tokB', expiresAt: 0 },
];
const seen = (sm, tok, name, u7, reset7, u5 = 0.1) => sm.update(tok, name, {
  'anthropic-ratelimit-unified-7d-utilization': String(u7),
  'anthropic-ratelimit-unified-7d-reset': String(reset7),
  'anthropic-ratelimit-unified-5h-utilization': String(u5),
});
const pick = (sm, current, exclude = new Set()) => pickByStrategy({ strategy: 'margin', currentToken: current, accounts, stateManager: sm, excludeTokens: exclude, now: NOW });

describe('margin', () => {
  it('un lavoro nuovo non va sull\'account oltre il ritmo quando un altro ha margine', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokA', 'corre', 0.85, S + 2 * D);   // 85% col 71% di settimana: ritmo 1,2, si azzera prima
    seen(sm, 'tokB', 'libero', 0.05, S + 6 * D);  // 5% col 14%: ritmo 0,35
    assert.equal(pickMostMargin(accounts, sm, new Set(), NOW).name, 'libero');
    const r = pick(sm, 'tokA');
    assert.deepEqual([r.rotated, r.account?.name], [true, 'libero']);
    // reset-first, la strategia di prima, sceglieva proprio quello che corre: è il caso del 21-23/10.
    const old = pickByStrategy({ strategy: 'reset-first', currentToken: 'tokB', accounts, stateManager: sm, now: NOW });
    assert.equal(old.account?.name, 'corre');
  });

  it('il margine sotto 100/7 vuol dire oltre il ritmo, sopra in linea', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokA', 'corre', 0.60, S + 4 * D); // 60% col 43%: corre
    seen(sm, 'tokB', 'libero', 0.30, S + 4 * D); // 30% col 43%: in linea
    assert.ok(weeklyMargin(sm.get('tokA'), NOW) < 100 / 7);
    assert.ok(weeklyMargin(sm.get('tokB'), NOW) > 100 / 7);
  });

  it('usa-o-perdi: quota avanzata a poche ore dal reset vince su un account fresco', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokA', 'corre', 0.50, S + 10 * H);
    seen(sm, 'tokB', 'libero', 0, S + 7 * D);
    assert.equal(pick(sm, 'tokB').account?.name, 'corre');
  });

  it('isteresi: resta sull\'attivo finché un altro non ha un quarto di margine in più', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokA', 'corre', 0, S + 7 * D);  // 14,3%/g
    seen(sm, 'tokB', 'libero', 0, S + 6 * D); // 16,7%/g: +17%
    assert.deepEqual(pick(sm, 'tokA'), { account: null, rotated: false });
    seen(sm, 'tokB', 'libero', 0, S + 5 * D); // 20%/g: +40%
    assert.equal(pick(sm, 'tokA').account?.name, 'libero');
  });

  it('settimana piena o modello in pausa sull\'attivo: cambia subito, senza isteresi', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokA', 'corre', 0.92, S + 7 * H);
    seen(sm, 'tokB', 'libero', 0.10, S + 6 * D);
    assert.equal(pick(sm, 'tokA').account?.name, 'libero');
    const sm2 = createAccountStateManager();
    seen(sm2, 'tokA', 'corre', 0, S + 7 * D);
    seen(sm2, 'tokB', 'libero', 0, S + 6.9 * D);
    assert.equal(pick(sm2, 'tokA', new Set(['tokA'])).account?.name, 'libero');
  });

  it('account mai letto = fresco (100% su sette giorni)', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokA', 'corre', 0.70, S + 3 * D); // 30% su 3 giorni = 10%/g
    assert.equal(pickMostMargin(accounts, sm, new Set(), NOW).name, 'libero');
  });

  it('attivo non disponibile: il sostituto lo sceglie il margine, non la 5h più bassa', () => {
    const sm = createAccountStateManager();
    const three = [...accounts, { name: 'terzo', token: 'tokC', expiresAt: 0 }];
    seen(sm, 'tokB', 'libero', 0.10, S + 6 * D, 0.5);
    seen(sm, 'tokC', 'terzo', 0.88, S + 5 * D, 0.0); // 5h vuota ma settimana quasi finita
    sm.markLimited('tokA', 'corre', 30 * D); // cooldown lungo: vale con qualunque orologio
    const r = pickByStrategy({ strategy: 'margin', currentToken: 'tokA', accounts: three, stateManager: sm, now: NOW });
    assert.equal(r.account?.name, 'libero');
  });

  it('è una strategia registrata', () => {
    assert.ok(ROTATION_STRATEGIES.margin);
  });
});
