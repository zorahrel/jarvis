/**
 * A 200 that carries no rate-limit headers must not erase what we know.
 *
 * The proxy calls updateAccountState() on *every* non-error response, and
 * `/v1/messages/count_tokens` is a plain 200 with none of the unified headers.
 * The persisting branch used to read every field as `Number(h[k] || 0)`, so a
 * single count_tokens call wrote utilization 0 and reset epoch 0 over a real
 * reading. Reset 0 is what the card renders as "rolling window", and the zeroed
 * utilization also fed the usage-cap check.
 *
 * This exercises the real function out of dashboard.mjs, so it fails against the
 * old code rather than against a re-implementation of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Normalised to LF on read. These tests slice the source on "\n}\n"; if git
// checked the file out with CRLF (the Windows default) that needle never
// matches, and the failure reads "<function> is not defined" — which points at
// the code rather than at the invisible byte that actually broke it.
const src = readFileSync(join(here, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');

// Lift updateAccountState() out of the server module: dashboard.mjs binds ports
// and reads the keychain on import, so it cannot be imported in a test.
const start = src.indexOf('function updateAccountState(');
assert.ok(start > 0, 'updateAccountState not found in dashboard.mjs');
const end = src.indexOf('\n}\n', start) + 3;
const body = src.slice(start, end);

function build(persistedState) {
  const recorded = { fiveH: [], weekly: [] };
  const stub = {
    accountState: { update() {}, get: () => ({ limited: false, retryAfter: 0 }) },
    persistedState,
    utilizationHistory: { getHistory: () => [], load() {}, record: (fp, a, b) => recorded.fiveH.push([a, b]) },
    weeklyHistory: { getHistory: () => [], load() {}, record: (fp, a, b) => recorded.weekly.push([a, b]) },
    _sparkCache: {},
    saveHistoryToDisk() {},
    updatePersistedState(fp, data) {
      const prev = persistedState[fp] || {};
      const pick = (k, d) => (data[k] !== undefined ? data[k] : (prev[k] !== undefined ? prev[k] : d));
      persistedState[fp] = {
        utilization5h: pick('utilization5h', 0),
        utilization7d: pick('utilization7d', 0),
        resetAt: pick('resetAt', 0),
        resetAt7d: pick('resetAt7d', 0),
        limited: pick('limited', false),
        retryAfter: pick('retryAfter', 0),
        updatedAt: Date.now(),
      };
    },
  };
  const names = Object.keys(stub);
  const fn = new Function(...names, `${body}; return updateAccountState;`)(...names.map(n => stub[n]));
  return { fn, recorded };
}

const FP = 'testfingerprint01';
const NOW_SEC = Math.floor(Date.now() / 1000);
const known = () => ({
  [FP]: {
    utilization5h: 0.54, utilization7d: 0.36,
    resetAt: NOW_SEC + 1800, resetAt7d: NOW_SEC + 200000,
    limited: false, retryAfter: 0, updatedAt: Date.now(),
  },
});

// What /v1/messages/count_tokens actually answers: a 200 with no unified headers.
const countTokens200 = { 'content-type': 'application/json', 'request-id': 'req_ct' };

test('a count_tokens 200 does not zero the persisted utilization', () => {
  const state = known();
  const { fn } = build(state);
  fn('tok', 'acct', countTokens200, FP);
  assert.equal(state[FP].utilization5h, 0.54, '5h utilization must survive a headerless 200');
  assert.equal(state[FP].utilization7d, 0.36, '7d utilization must survive a headerless 200');
});

test('a count_tokens 200 does not zero the reset epoch (the "rolling window" bug)', () => {
  const state = known();
  const { fn } = build(state);
  fn('tok', 'acct', countTokens200, FP);
  assert.notEqual(state[FP].resetAt, 0, 'resetAt 0 is what the card renders as "rolling window"');
  assert.equal(state[FP].resetAt, NOW_SEC + 1800);
  assert.equal(state[FP].resetAt7d, NOW_SEC + 200000);
});

test('a headerless response does not push a fake 0 into the sparkline history', () => {
  const state = known();
  const { fn, recorded } = build(state);
  fn('tok', 'acct', countTokens200, FP);
  assert.deepEqual(recorded.fiveH, [], 'no reading arrived, so nothing may be recorded');
  assert.deepEqual(recorded.weekly, []);
});

test('a partial response keeps the fields it did not mention', () => {
  const state = known();
  const { fn } = build(state);
  // A 429 that carries only the 5h fields must not blank the 7d ones.
  fn('tok', 'acct', {
    'anthropic-ratelimit-unified-5h-utilization': '1.0',
    'anthropic-ratelimit-unified-5h-reset': String(NOW_SEC + 60),
  }, FP);
  assert.equal(state[FP].utilization5h, 1.0, 'the field that arrived lands');
  assert.equal(state[FP].utilization7d, 0.36, 'the field that did not arrive is preserved');
  assert.equal(state[FP].resetAt7d, NOW_SEC + 200000);
});

test('a real full reading still overwrites the previous one, including a genuine 0', () => {
  const state = known();
  const { fn, recorded } = build(state);
  fn('tok', 'acct', {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0',
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
    'anthropic-ratelimit-unified-5h-reset': String(NOW_SEC + 900),
    'anthropic-ratelimit-unified-7d-reset': String(NOW_SEC + 300000),
  }, FP);
  assert.equal(state[FP].utilization5h, 0, 'a header that reads "0" is a real zero and must land');
  assert.equal(state[FP].utilization7d, 0.4);
  assert.equal(state[FP].resetAt, NOW_SEC + 900);
  assert.deepEqual(recorded.fiveH, [[0, 0.4]], 'a real reading is recorded');
});
