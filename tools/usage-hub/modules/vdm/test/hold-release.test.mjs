// A held request must be released at the instant its account comes back, not
// one second before it.
//
// The incident (2026-09-25): at every 5h reset of the day (05:20, 10:20) every
// parked request got "hold expired — returning 429" instead of resuming. The hold
// ended at the account's retry-after (14:31:16 + 2923s = 15:19:59.x), but
// isAccountAvailable also waits for the 5h reset second (resetAt 15:20:00, and
// `resetAt >= nowSec` still holds during that second). So the final check said
// "nothing selectable", and requests arriving inside that second were parked for
// 0s and failed too. The hold deadline is now the first instant the account is
// really available (accountFreeAt in lib.mjs, used by holdOutlook).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAccountAvailable, accountFreeAt } from '../lib.mjs';

const R = 1_790_344_800;            // the 5h reset, in seconds, as Anthropic sends it
const at429 = R * 1000 - 2923_000 - 300;
const limited5h = { limited: true, retryAfter: at429 + 2923_000, resetAt: R };
const sm = (state) => ({ get: () => state });

test('the old deadline: retry-after passed, the reset second not over → still unavailable', () => {
  assert.equal(isAccountAvailable('t', 0, sm(limited5h), limited5h.retryAfter + 1), false);
  assert.equal(isAccountAvailable('t', 0, sm(limited5h), R * 1000 + 999), false);
});

test('accountFreeAt is the first instant the account is available', () => {
  const at = accountFreeAt(limited5h);
  assert.equal(isAccountAvailable('t', 0, sm(limited5h), at), true);
  assert.equal(isAccountAvailable('t', 0, sm(limited5h), at - 1), false);
});

test('a week-long cooldown outlasts the 5h reset', () => {
  // account-b@example.com the same day: 7d full, retry-after to Sunday 11:00.
  const week = { limited: true, retryAfter: (R + 160122) * 1000, resetAt: R };
  const at = accountFreeAt(week);
  assert.equal(isAccountAvailable('t', 0, sm(week), at), true);
  assert.equal(isAccountAvailable('t', 0, sm(week), at - 1), false);
});

test('only a reset, or only a cooldown, or nothing known', () => {
  const onlyReset = { limited: true, retryAfter: 0, resetAt: R };
  assert.equal(isAccountAvailable('t', 0, sm(onlyReset), accountFreeAt(onlyReset)), true);
  assert.equal(isAccountAvailable('t', 0, sm(onlyReset), accountFreeAt(onlyReset) - 1), false);
  const onlyCooldown = { limited: true, retryAfter: R * 1000, resetAt: 0 };
  assert.equal(isAccountAvailable('t', 0, sm(onlyCooldown), accountFreeAt(onlyCooldown)), true);
  assert.equal(accountFreeAt({ limited: true }), 0);
  assert.equal(accountFreeAt(undefined), 0);
});
