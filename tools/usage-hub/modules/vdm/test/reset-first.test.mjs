// Strategia reset-first (18/10): prima l'account il cui limite settimanale si azzera prima.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStateManager, pickResetFirst, pickByStrategy, ROTATION_STRATEGIES } from '../lib.mjs';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const S = Math.floor(NOW / 1000), D = 86400;
const accounts = [
  { name: 'account-a', token: 'tokZ', expiresAt: 0 },
  { name: 'account-b', token: 'tokG', expiresAt: 0 },
];
const seen = (sm, tok, name, u7, reset7, u5 = 0.1) => sm.update(tok, name, {
  'anthropic-ratelimit-unified-7d-utilization': String(u7),
  'anthropic-ratelimit-unified-7d-reset': String(reset7),
  'anthropic-ratelimit-unified-5h-utilization': String(u5),
});

describe('reset-first', () => {
  it('sceglie l\'account che si azzera prima', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokZ', 'account-a', 0.04, S + 7 * D);
    seen(sm, 'tokG', 'account-b', 0.30, S + 3 * D);
    assert.equal(pickResetFirst(accounts, sm, new Set(), NOW).name, 'account-b');
  });

  it('salta chi ha la settimana piena', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokZ', 'account-a', 0.04, S + 7 * D);
    seen(sm, 'tokG', 'account-b', 0.95, S + 3 * D);
    assert.equal(pickResetFirst(accounts, sm, new Set(), NOW).name, 'account-a');
  });

  it('reset sconosciuto va in fondo', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokG', 'account-b', 0.5, S + 6 * D);
    assert.equal(pickResetFirst(accounts, sm, new Set(), NOW).name, 'account-b');
  });

  it('pickByStrategy ruota sull\'account che scade prima', () => {
    const sm = createAccountStateManager();
    seen(sm, 'tokZ', 'account-a', 0.04, S + 7 * D);
    seen(sm, 'tokG', 'account-b', 0.30, S + 3 * D);
    const r = pickByStrategy({ strategy: 'reset-first', currentToken: 'tokZ', accounts, stateManager: sm, now: NOW });
    assert.deepEqual([r.rotated, r.account?.name], [true, 'account-b']);
    const stay = pickByStrategy({ strategy: 'reset-first', currentToken: 'tokG', accounts, stateManager: sm, now: NOW });
    assert.equal(stay.rotated, false);
  });

  it('è una strategia registrata', () => {
    assert.ok(ROTATION_STRATEGIES['reset-first']);
  });
});
