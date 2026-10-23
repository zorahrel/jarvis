// A 429 on ONE model must not take the account out of rotation for the others.
//
// The incident (2026-09-25, 00:22): account-a@example.com answered 429 with
// retry-after 452236s (5.2 days, exactly its weekly reset) while its plan
// windows read 5h 2% and 7d 0%. That is a per-model allowance (the weekly Opus
// cap, or its 1M-context variant), yet VDM filed it as an account-wide cooldown:
// the account left rotation for every model, the hold gate parked every session
// for up to 24h, and the Haiku probe could not lift it. Now the cooldown is
// scoped to the model that got it, and the account keeps serving the others.
//
// The logic lives in lib.mjs (dashboard.mjs starts a server on import);
// LOCAL-PATCHES.md, 2026-09-25, records where dashboard.mjs calls it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestModelKey, isPerModel429, createModelBlocks, isMisfiledModelCooldown } from '../lib.mjs';

const now = 1_800_000_000_000;
const body = (model) => Buffer.from(JSON.stringify({ model, max_tokens: 10, messages: [] }));

test('the request model key: the family, plus -1m for the 1M-context beta', () => {
  assert.equal(requestModelKey(body('claude-opus-5-5'), {}), 'opus');
  assert.equal(requestModelKey(body('claude-opus-5-5'), { 'anthropic-beta': 'oauth-2025-04-20,context-1m-2025-08-07' }), 'opus-1m');
  assert.equal(requestModelKey(body('claude-sonnet-5'), {}), 'sonnet');
  assert.equal(requestModelKey(body('claude-haiku-4-5-20251001'), {}), 'haiku');
  assert.equal(requestModelKey(Buffer.from('not json'), {}), '');
  assert.equal(requestModelKey(Buffer.alloc(0), {}), '');
});

test('the incident: 429, retry-after 5 days, plan windows free → a model limit', () => {
  const state = { updatedAt: now - 60_000, utilization5h: 0.02, utilization7d: 0 };
  assert.equal(isPerModel429({ retryAfter: 452236, headers: {}, state, now }), true);
});

test('the 429 own utilization headers win over the stored reading', () => {
  const stale = { updatedAt: now - 3 * 3600_000, utilization5h: 0.02 };
  const free = { 'anthropic-ratelimit-unified-5h-utilization': '0.3', 'anthropic-ratelimit-unified-7d-utilization': '0.12' };
  assert.equal(isPerModel429({ retryAfter: 452236, headers: free, state: stale, now }), true);
  const full = { 'anthropic-ratelimit-unified-7d-utilization': '1' };
  assert.equal(isPerModel429({ retryAfter: 452236, headers: full, state: { updatedAt: now, utilization7d: 0 }, now }), false);
});

test('a real exhaustion stays account-wide', () => {
  // account-b@example.com the same night: 7d at 100%, retry-after to the weekly reset.
  assert.equal(isPerModel429({ retryAfter: 211035, headers: {}, state: { updatedAt: now - 60_000, utilization7d: 1 }, now }), false);
});

test('without a trustworthy reading the old account-wide rule applies', () => {
  assert.equal(isPerModel429({ retryAfter: 452236, headers: {}, state: { updatedAt: now - 3 * 3600_000, utilization5h: 0 }, now }), false);
  assert.equal(isPerModel429({ retryAfter: 452236, headers: {}, state: undefined, now }), false);
});

test('a short wall is not a model allowance', () => {
  assert.equal(isPerModel429({ retryAfter: 120, headers: {}, state: { updatedAt: now, utilization5h: 0.1 }, now }), false);
});

test('model blocks: per model, per account name, and they expire', () => {
  const b = createModelBlocks();
  b.mark('auto-2', 'opus-1m', 452236, now);
  assert.deepEqual([...b.blockedNames('opus-1m', now)], ['auto-2']);
  assert.deepEqual([...b.blockedNames('sonnet', now)], []);
  // Opus at 200k draws on a different allowance than Opus at 1M.
  assert.deepEqual([...b.blockedNames('opus', now)], []);
  assert.deepEqual([...b.blockedNames('', now)], []);
  assert.deepEqual([...b.blockedNames('opus-1m', now + 452237_000)], []);
  assert.deepEqual(b.active('auto-2', now), [{ model: 'opus-1m', until: now + 452236_000 }]);
  // A restart reads it back from its JSON, expired entries gone.
  const again = createModelBlocks(JSON.parse(JSON.stringify(b.toJSON(now))));
  assert.deepEqual([...again.blockedNames('opus-1m', now)], ['auto-2']);
  assert.deepEqual(createModelBlocks(b.toJSON(now + 452237_000)).active('auto-2', now), []);
});

test('the misfiled cooldown from before the fix is recognised, a real one is not', () => {
  // auto-2 as persisted on 2026-09-25: account-wide, kind 'model', windows free, days left.
  assert.equal(isMisfiledModelCooldown({ limited: true, blockKind: 'model', retryAfter: now + 5 * 86400_000, utilization5h: 0.02, utilization7d: 0 }, now), true);
  // auto-1: same kind, but its week really is full.
  assert.equal(isMisfiledModelCooldown({ limited: true, blockKind: 'model', retryAfter: now + 2 * 86400_000, utilization5h: 0, utilization7d: 1 }, now), false);
  // A short account-wide cooldown (a burst the server throttled) is left alone.
  assert.equal(isMisfiledModelCooldown({ limited: true, blockKind: 'model', retryAfter: now + 300_000, utilization5h: 0.1 }, now), false);
  assert.equal(isMisfiledModelCooldown({ blockKind: 'extra-usage', retryAfter: now + 5 * 86400_000, utilization5h: 0 }, now), false);
  assert.equal(isMisfiledModelCooldown({ blockKind: 'model', retryAfter: now - 1, utilization5h: 0 }, now), false);
});

test('a paused model is tried again every 10 minutes, and one answer lifts the pause', () => {
  // 00:55 the same night: opus[1m] answered on account-a@example.com half an hour after
  // the 429 that claimed 5.2 days. A pause nobody re-tests would have held it all week.
  const b = createModelBlocks();
  b.mark('auto-2', 'opus-1m', 452236, now);
  assert.equal(b.probeDue('auto-2', 'opus-1m', now + 60_000), false, 'the 429 itself was the last try');
  assert.equal(b.probeDue('auto-2', 'opus-1m', now + 10 * 60_000), true);
  b.markProbe('auto-2', 'opus-1m', now + 10 * 60_000);
  assert.equal(b.probeDue('auto-2', 'opus-1m', now + 11 * 60_000), false, 'one request tests it, not every request');
  b.clear('auto-2', 'opus-1m');
  assert.deepEqual(b.active('auto-2', now), []);
  assert.deepEqual([...b.blockedNames('opus-1m', now)], []);
  // After a restart nobody knows when it was last tried: the first request tests it.
  assert.equal(createModelBlocks({ 'auto-2': { 'opus-1m': now + 3600_000 } }).probeDue('auto-2', 'opus-1m', now), true);
});
