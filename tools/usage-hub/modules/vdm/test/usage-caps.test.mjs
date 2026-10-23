import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountStateManager,
  effectiveUtilization,
  normalizeCapPercent,
  resolveAccountCaps,
  isOverUsageCap,
  usageCapState,
  isSelectableAccount,
  pickBestAccount,
  pickByPriority,
  pickAnyUntried,
  pickByStrategy,
} from '../lib.mjs';

const NOW = 1_800_000_000_000;          // fixed clock, ms
const NOW_SEC = Math.floor(NOW / 1000);
const HOUR = 3600;

/** Build a state manager pre-loaded with one account's window state. */
function stateWith(token, { u5h = 0, u7d = 0, resetAt = NOW_SEC + HOUR, resetAt7d = NOW_SEC + 24 * HOUR, limited = false, retryAfter = 0 } = {}) {
  const sm = createAccountStateManager();
  sm.update(token, 'acct', {
    'anthropic-ratelimit-unified-status': limited ? 'limited' : 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': String(u5h),
    'anthropic-ratelimit-unified-7d-utilization': String(u7d),
    'anthropic-ratelimit-unified-5h-reset': String(resetAt),
    'anthropic-ratelimit-unified-7d-reset': String(resetAt7d),
  });
  if (retryAfter) sm.markLimited(token, 'acct', retryAfter);
  return sm;
}

function acct(name, token, extra = {}) {
  return { name, token, label: name, expiresAt: NOW + 86_400_000, priority: 0, disabled: false, ...extra };
}

// ── normalizeCapPercent ──

test('normalizeCapPercent maps percent to the 0..1 utilization scale', () => {
  assert.equal(normalizeCapPercent(80), 0.8);
  assert.equal(normalizeCapPercent('45'), 0.45);
  assert.equal(normalizeCapPercent(0.5), 0.005); // 0.5 percent, not 50%
});

test('normalizeCapPercent treats out-of-range and blank as no cap', () => {
  for (const v of [null, undefined, '', 'abc', NaN, 0, -10, 100, 150]) {
    assert.equal(normalizeCapPercent(v), null, `expected no cap for ${JSON.stringify(v)}`);
  }
});

// ── effectiveUtilization ──

test('effectiveUtilization reads the live value inside the window', () => {
  const sm = stateWith('t', { u5h: 0.77, u7d: 0.4 });
  assert.equal(effectiveUtilization(sm.get('t'), '5h', NOW), 0.77);
  assert.equal(effectiveUtilization(sm.get('t'), '7d', NOW), 0.4);
});

test('effectiveUtilization reads zero once the window has rolled over', () => {
  const sm = stateWith('t', { u5h: 0.99, u7d: 0.99, resetAt: NOW_SEC - 60, resetAt7d: NOW_SEC - 60 });
  assert.equal(effectiveUtilization(sm.get('t'), '5h', NOW), 0);
  assert.equal(effectiveUtilization(sm.get('t'), '7d', NOW), 0);
});

test('effectiveUtilization is zero for an account we have never seen', () => {
  const sm = createAccountStateManager();
  assert.equal(effectiveUtilization(sm.get('unknown'), '5h', NOW), 0);
});

// ── resolveAccountCaps ──

test('resolveAccountCaps: per-account override beats the global cap', () => {
  const caps = resolveAccountCaps({ fiveH: 30, sevenD: 40 }, { fiveH: 90, sevenD: 90 });
  assert.deepEqual(caps, { fiveH: 0.3, sevenD: 0.4 });
});

test('resolveAccountCaps: unset fields fall through to the global cap, field by field', () => {
  const caps = resolveAccountCaps({ fiveH: 30 }, { fiveH: 90, sevenD: 85 });
  assert.deepEqual(caps, { fiveH: 0.3, sevenD: 0.85 });
});

test('resolveAccountCaps: no override and no global means no cap', () => {
  assert.deepEqual(resolveAccountCaps(null, null), { fiveH: null, sevenD: null });
  assert.deepEqual(resolveAccountCaps({}, {}), { fiveH: null, sevenD: null });
});

// ── isOverUsageCap ──

test('isOverUsageCap is false when no cap is configured, however high the usage', () => {
  const sm = stateWith('t', { u5h: 0.99, u7d: 0.99 });
  assert.equal(isOverUsageCap(acct('a', 't'), sm, NOW), false);
});

test('isOverUsageCap fires on the 5h window at or above the cap', () => {
  const sm = stateWith('t', { u5h: 0.8 });
  assert.equal(isOverUsageCap(acct('a', 't', { capFiveH: 0.8 }), sm, NOW), true);
  assert.equal(isOverUsageCap(acct('a', 't', { capFiveH: 0.81 }), sm, NOW), false);
});

test('isOverUsageCap fires on the 7d window independently of the 5h one', () => {
  const sm = stateWith('t', { u5h: 0.01, u7d: 0.9 });
  assert.equal(isOverUsageCap(acct('a', 't', { capSevenD: 0.85 }), sm, NOW), true);
  assert.equal(isOverUsageCap(acct('a', 't', { capFiveH: 0.5 }), sm, NOW), false);
});

test('isOverUsageCap releases the account once the capped window resets', () => {
  const a = acct('a', 't', { capFiveH: 0.5 });
  const live = stateWith('t', { u5h: 0.9, resetAt: NOW_SEC + HOUR });
  assert.equal(isOverUsageCap(a, live, NOW), true);
  const rolled = stateWith('t', { u5h: 0.9, resetAt: NOW_SEC - 1 });
  assert.equal(isOverUsageCap(a, rolled, NOW), false, 'stale utilization must not outlive its window');
});

// ── usageCapState ──

test('usageCapState reports which window is over and when it frees up', () => {
  const sm = stateWith('t', { u5h: 0.9, u7d: 0.9, resetAt: NOW_SEC + HOUR, resetAt7d: NOW_SEC + 48 * HOUR });
  const s = usageCapState(acct('a', 't', { capFiveH: 0.5, capSevenD: 0.5 }), sm, NOW);
  assert.deepEqual({ over5h: s.over5h, over7d: s.over7d, over: s.over }, { over5h: true, over7d: true, over: true });
  assert.equal(s.freeAt, (NOW_SEC + 48 * HOUR) * 1000, 'free only when the LAST capped window rolls over');
});

test('usageCapState reports freeAt 0 rather than guessing when a reset is unknown', () => {
  const sm = stateWith('t', { u7d: 1, resetAt7d: 0 });
  const s = usageCapState(acct('a', 't', { capSevenD: 0.8 }), sm, NOW);
  assert.equal(s.over, true);
  assert.equal(s.freeAt, 0);
});

// ── isSelectableAccount ──

test('isSelectableAccount rejects for each reason independently', () => {
  const sm = stateWith('t', { u5h: 0.9 });
  assert.equal(isSelectableAccount(acct('a', 't'), sm, new Set(), NOW), true);
  assert.equal(isSelectableAccount(acct('a', 't'), sm, new Set(['t']), NOW), false, 'excluded');
  assert.equal(isSelectableAccount(acct('a', 't', { disabled: true }), sm, new Set(), NOW), false, 'disabled');
  assert.equal(isSelectableAccount(acct('a', 't', { capFiveH: 0.5 }), sm, new Set(), NOW), false, 'over cap');
  assert.equal(isSelectableAccount(acct('a', 't', { expiresAt: NOW - 1 }), sm, new Set(), NOW), false, 'expired');
});

// ── pickers honour the cap ──

test('pickBestAccount skips a capped account in favour of an uncapped one', () => {
  const sm = createAccountStateManager();
  for (const [tok, u] of [['t1', 0.1], ['t2', 0.5]]) {
    sm.update(tok, tok, {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(u),
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SEC + HOUR),
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SEC + 24 * HOUR),
    });
  }
  const accounts = [acct('low', 't1', { capFiveH: 0.05 }), acct('high', 't2')];
  // 'low' has the lower utilization and would normally win — but it is over its cap.
  assert.equal(pickBestAccount(accounts, sm, new Set())?.name, 'high');
});

test('pickByPriority skips a capped favourite and falls through to the next', () => {
  const sm = createAccountStateManager();
  for (const [tok, u] of [['t1', 0.9], ['t2', 0.1]]) {
    sm.update(tok, tok, {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(u),
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SEC + HOUR),
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SEC + 24 * HOUR),
    });
  }
  const accounts = [acct('fav', 't1', { priority: 9, capFiveH: 0.8 }), acct('backup', 't2', { priority: 1 })];
  assert.equal(pickByPriority(accounts, sm, new Set(), NOW)?.name, 'backup');
});

test('pickBestAccount returns null when every account is over its cap', () => {
  const sm = stateWith('t1', { u5h: 0.9 });
  const accounts = [acct('only', 't1', { capFiveH: 0.5 })];
  assert.equal(pickBestAccount(accounts, sm, new Set()), null);
});

test('pickAnyUntried does not walk through the cap when given the state manager', () => {
  const sm = stateWith('t1', { u5h: 0.9 });
  const accounts = [acct('only', 't1', { capFiveH: 0.5 })];
  assert.equal(pickAnyUntried(accounts, new Set(), sm, NOW), null);
  assert.equal(pickAnyUntried(accounts, new Set())?.name, 'only', 'legacy 2-arg call is unchanged');
});

// ── pickByStrategy ──

test('sticky moves off the current account once it crosses its cap', () => {
  const sm = createAccountStateManager();
  for (const [tok, u] of [['t1', 0.9], ['t2', 0.1]]) {
    sm.update(tok, tok, {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(u),
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SEC + HOUR),
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SEC + 24 * HOUR),
    });
  }
  const accounts = [acct('cur', 't1', { capFiveH: 0.8 }), acct('other', 't2')];
  const r = pickByStrategy({ strategy: 'sticky', currentToken: 't1', lastRotationTime: 0, accounts, stateManager: sm, now: NOW });
  assert.equal(r.account?.name, 'other');
  assert.equal(r.rotated, true);
});

test('sticky stays put while the current account is under its cap', () => {
  const sm = stateWith('t1', { u5h: 0.5 });
  const accounts = [acct('cur', 't1', { capFiveH: 0.8 })];
  const r = pickByStrategy({ strategy: 'sticky', currentToken: 't1', lastRotationTime: 0, accounts, stateManager: sm, now: NOW });
  assert.equal(r.account, null);
  assert.equal(r.rotated, false);
});

test('pickByStrategy reports exhaustion when the caps leave nothing selectable', () => {
  const sm = stateWith('t1', { u5h: 0.9 });
  const accounts = [acct('cur', 't1', { capFiveH: 0.5 })];
  const r = pickByStrategy({ strategy: 'priority', currentToken: 't1', lastRotationTime: 0, accounts, stateManager: sm, now: NOW });
  assert.equal(r.account, null);
  assert.equal(r.rotated, false);
});
