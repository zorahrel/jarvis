import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStateManager, isOverUsageCap, effectiveUtilization } from '../lib.mjs';

const NOW_SEC = Math.floor(Date.now() / 1000);

const full = (u5h, u7d) => ({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': String(u5h),
  'anthropic-ratelimit-unified-7d-utilization': String(u7d),
  'anthropic-ratelimit-unified-5h-reset': String(NOW_SEC + 3600),
  'anthropic-ratelimit-unified-7d-reset': String(NOW_SEC + 86400),
});

// A real response that simply carried no rate-limit headers.
const bare = { 'content-type': 'application/json', 'request-id': 'req_x' };

test('a response with no rate-limit headers keeps the last known reading', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.92, 0.7));
  sm.update('t', 'acct', bare);
  const s = sm.get('t');
  assert.equal(s.utilization5h, 0.92, 'must not be zeroed');
  assert.equal(s.utilization7d, 0.7);
  assert.ok(s.resetAt > NOW_SEC, 'reset time preserved too');
});

test('the age of the reading is reported honestly, not refreshed by a silent response', async () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.5, 0.5));
  const firstSeen = sm.get('t').updatedAt;
  await new Promise(r => setTimeout(r, 5));
  sm.update('t', 'acct', bare);
  assert.equal(sm.get('t').updatedAt, firstSeen,
    'a response carrying no information must not claim the reading is fresh');
});

test('a real reading still overwrites the previous one', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.9, 0.9));
  sm.update('t', 'acct', full(0.1, 0.2));
  assert.equal(sm.get('t').utilization5h, 0.1);
  assert.equal(sm.get('t').utilization7d, 0.2);
});

test('a genuine zero from real headers is still recorded as zero', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.9, 0.9));
  sm.update('t', 'acct', full(0, 0)); // window really did roll over
  assert.equal(sm.get('t').utilization5h, 0, 'a real zero must not be mistaken for missing data');
});

test('a silent response does not un-cap an account that is over its cap', () => {
  // The regression this guards: zeroing utilization also zeroes what the cap
  // check reads, so a capped account would quietly become selectable again.
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.95, 0.5));
  const acct = { token: 't', capFiveH: 0.75, capSevenD: null };
  assert.equal(isOverUsageCap(acct, sm), true);
  sm.update('t', 'acct', bare);
  assert.equal(isOverUsageCap(acct, sm), true, 'still over cap — nothing said otherwise');
});

test('a silent response for an account we have never seen records nothing', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', bare);
  assert.equal(sm.get('t'), undefined, 'inventing a zero reading would be worse than none');
  assert.equal(effectiveUtilization(sm.get('t'), '5h'), 0);
});

test('a silent response clears an expired flag but leaves the limits alone', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.8, 0.4));
  sm.markExpired('t', 'acct');
  assert.equal(sm.get('t').expired, true);
  sm.update('t', 'acct', bare);
  assert.equal(sm.get('t').expired, false, 'a response arrived, so the token is live');
  assert.equal(sm.get('t').utilization5h, 0.8, 'but it said nothing about limits');
});

test('a partial header set still counts as a reading', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.9, 0.9));
  sm.update('t', 'acct', { 'anthropic-ratelimit-unified-5h-utilization': '0.3' });
  assert.equal(sm.get('t').utilization5h, 0.3, 'the header that was present is authoritative');
});

// The case that actually bit: a 429 arrives with `unified-status: limited` and no
// utilization headers at all. A response-level "did it carry anything?" check
// accepts it, and the missing fields land as 0 — blanking a full account.
const statusOnly429 = { 'anthropic-ratelimit-unified-status': 'limited' };

test('a 429 carrying only the status header does not blank the utilization', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0, 1));            // weekly window genuinely full
  sm.update('t', 'acct', statusOnly429);
  const s = sm.get('t');
  assert.equal(s.utilization7d, 1, 'still 100% — the 429 said nothing about utilization');
  assert.equal(s.limited, true, 'but the status it DID carry is applied');
});

test('a 429 with only the status header cannot un-cap a capped account', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.9, 0.4));
  const acct = { token: 't', capFiveH: 0.75, capSevenD: null };
  assert.equal(isOverUsageCap(acct, sm), true);
  sm.update('t', 'acct', statusOnly429);
  assert.equal(isOverUsageCap(acct, sm), true,
    'a status-only 429 must not hand a capped account back to the rotation');
});

test('reset times survive a status-only response', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.5, 0.5));
  const { resetAt, resetAt7d } = sm.get('t');
  sm.update('t', 'acct', statusOnly429);
  assert.equal(sm.get('t').resetAt, resetAt, 'losing the reset makes the window look already rolled over');
  assert.equal(sm.get('t').resetAt7d, resetAt7d);
});

test('one window reported, the other silent: only the reported one moves', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.2, 0.8));
  sm.update('t', 'acct', {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.6',
  });
  const s = sm.get('t');
  assert.equal(s.utilization5h, 0.6, 'reported');
  assert.equal(s.utilization7d, 0.8, 'not reported — unchanged');
});

test('an active 429 cooldown survives a silent response', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0, 1));
  sm.markLimited('t', 'acct', 3600);
  const cooldown = sm.get('t').retryAfter;
  sm.update('t', 'acct', bare);
  assert.equal(sm.get('t').retryAfter, cooldown, 'a real cooldown is not forgotten');
  assert.equal(sm.get('t').limited, true);
});

test('an Extra Usage cooldown survives a plan-limit refresh with its own reason', () => {
  // Anthropic can report the plan windows as healthy while refusing third-party
  // traffic because its separate Extra Usage allowance is empty.
  const sm = createAccountStateManager();
  sm.update('t', 'acct', full(0.14, 0.23));
  sm.markLimited('t', 'acct', 3600, 'extra-usage');
  sm.update('t', 'acct', full(0.14, 0.23));
  assert.equal(sm.get('t').blockKind, 'extra-usage');
  assert.equal(sm.get('t').limited, true);
});

// ── hydrate: the bridge from the durable copy to the live state ──
//
// The live state is keyed by access token and empties on restart; the durable one
// is keyed by fingerprint. Without this bridge the first response after a restart
// has nothing to preserve against, so every field it omits lands as 0.

test('hydrate restores the last known reading, age included', () => {
  const sm = createAccountStateManager();
  const snap = { utilization5h: 1, utilization7d: 0.71, resetAt: NOW_SEC + 900,
                 resetAt7d: NOW_SEC + 90000, limited: true, retryAfter: 0, updatedAt: 1234 };
  sm.hydrate('t', 'acct', snap);
  const s = sm.get('t');
  assert.equal(s.utilization5h, 1);
  assert.equal(s.utilization7d, 0.71);
  assert.equal(s.resetAt, snap.resetAt);
  assert.equal(s.limited, true);
  assert.equal(s.updatedAt, 1234, 'the reading is as old as it was on disk, not fresh');
});

test('after hydrate, a status-only 429 no longer blanks the account', () => {
  // This is the exact sequence that showed 100% on disk and 0% on the card.
  const sm = createAccountStateManager();
  sm.hydrate('t', 'acct', { utilization5h: 0, utilization7d: 1, resetAt: 0,
                            resetAt7d: NOW_SEC + 90000, limited: true, updatedAt: 1 });
  sm.update('t', 'acct', { 'anthropic-ratelimit-unified-status': 'limited' });
  assert.equal(sm.get('t').utilization7d, 1, 'weekly window is still full');
});

test('without hydrate the same sequence loses the reading — the bug this guards', () => {
  const sm = createAccountStateManager();
  sm.update('t', 'acct', { 'anthropic-ratelimit-unified-status': 'limited' });
  assert.equal(sm.get('t').utilization7d, 0,
    'nothing to preserve against: this is why the startup bridge has to exist');
});

test('hydrate ignores a missing snapshot rather than inventing zeros', () => {
  const sm = createAccountStateManager();
  sm.hydrate('t', 'acct', null);
  assert.equal(sm.get('t'), undefined);
});
