// A 429 with no retry-after must not be read as a transient burst when the
// account's own measured utilization says it is exhausted.
//
// The bug this pins: `const isTransient = retryAfter < 60` treated a missing
// header (parsed to 0) as a short burst. Measured over the real log, 3389 of
// ~3500 429s carried `retry-after: 0`, so the rule fired almost every time: the
// account was never marked limited, no switch was ever triggered, and jcode took
// eight consecutive 429s on an exhausted account while a 0%-used one sat idle.
//
// The cross-check uses state vdm already holds. Two guards matter and are both
// pinned below: the reading must be FRESH (a stale one would sideline a healthy
// account) and at the CEILING (mid-window traffic must stay transient, or a
// normal burst would knock accounts out of rotation).
//
// Mirrored from handleProxyRequest in dashboard.mjs, which starts a server on
// import. LOCAL-PATCHES.md records the pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const FRESH_MS = 5 * 60 * 1000;

/** Mirror of the classification in dashboard.mjs. */
function classify429(retryAfter, state, now = Date.now()) {
  const stateAge = state?.updatedAt ? now - state.updatedAt : Infinity;
  const util = Math.max(state?.utilization5h || 0, state?.utilization7d || 0);
  const looksExhausted = stateAge < FRESH_MS && util >= 0.95;
  const isTransient = retryAfter < 60 && !looksExhausted;
  const effectiveRetry = isTransient ? 0 : (retryAfter > 0
    ? retryAfter
    : (state?.resetAt > now / 1000 ? Math.round(state.resetAt - now / 1000) : 300));
  return { isTransient, looksExhausted, effectiveRetry };
}

const now = 1_800_000_000_000;
const fresh = (over) => ({ updatedAt: now - 60_000, ...over });

test('the regression case: 429, no retry-after, account at 95%', () => {
  // Exactly what the log showed on account-a@example.com.
  const r = classify429(0, fresh({ utilization5h: 0.95, utilization7d: 0.64 }), now);
  assert.equal(r.isTransient, false, 'must NOT be dismissed as a transient burst');
  assert.equal(r.looksExhausted, true);
});

test('a real burst mid-window stays transient', () => {
  // The behaviour the original rule exists for: an account with room left must
  // keep its traffic instead of being knocked out of rotation.
  const r = classify429(0, fresh({ utilization5h: 0.42, utilization7d: 0.30 }), now);
  assert.equal(r.isTransient, true);
  assert.equal(r.effectiveRetry, 0, 'no cooldown for a transient burst');
});

test('a STALE reading at 100% is not trusted', () => {
  // Sidelining an account on an hour-old measurement would cause the very
  // outage this is meant to prevent.
  const stale = { updatedAt: now - 60 * 60 * 1000, utilization5h: 1.0 };
  assert.equal(classify429(0, stale, now).isTransient, true);
});

test('a reading right at the freshness edge is not trusted', () => {
  const edge = { updatedAt: now - FRESH_MS, utilization5h: 1.0 };
  assert.equal(classify429(0, edge, now).isTransient, true, 'exactly 5 min old is too old');
  const inside = { updatedAt: now - FRESH_MS + 1000, utilization5h: 1.0 };
  assert.equal(classify429(0, inside, now).isTransient, false);
});

test('the ceiling is 95%, and 94% is still transient', () => {
  assert.equal(classify429(0, fresh({ utilization5h: 0.94 }), now).isTransient, true);
  assert.equal(classify429(0, fresh({ utilization5h: 0.95 }), now).isTransient, false);
});

test('the 7d window alone can mark exhaustion', () => {
  // A weekly cap can be hit with an empty 5h window; taking the max covers both.
  const r = classify429(0, fresh({ utilization5h: 0.01, utilization7d: 0.99 }), now);
  assert.equal(r.isTransient, false);
});

test('an explicit long retry-after still wins on its own', () => {
  // The pre-existing path must keep working with no state at all.
  const r = classify429(3600, null, now);
  assert.equal(r.isTransient, false);
  assert.equal(r.effectiveRetry, 3600, "the server's own value is not second-guessed");
});

test('missing state never marks an account exhausted', () => {
  // A brand-new account has no reading; guessing would take it out of rotation
  // before it ever served a request.
  assert.equal(classify429(0, null, now).isTransient, true);
  assert.equal(classify429(0, {}, now).isTransient, true);
  assert.equal(classify429(0, { utilization5h: 0.99 }, now).isTransient, true, 'no updatedAt = not fresh');
});

test('with no retry-after, the hold runs to the account\'s own reset', () => {
  const resetIn = 1800;
  const r = classify429(0, fresh({ utilization5h: 0.97, resetAt: now / 1000 + resetIn }), now);
  assert.equal(r.effectiveRetry, resetIn, 'hold until the window actually resets');
});

test('an unknown reset falls back to 5 minutes, not an invented long hold', () => {
  // A wrong long cooldown would strand a usable account for hours.
  const r = classify429(0, fresh({ utilization5h: 0.97 }), now);
  assert.equal(r.effectiveRetry, 300);
});

test('a past reset epoch does not produce a negative hold', () => {
  const r = classify429(0, fresh({ utilization5h: 0.97, resetAt: now / 1000 - 500 }), now);
  assert.equal(r.effectiveRetry, 300);
});
