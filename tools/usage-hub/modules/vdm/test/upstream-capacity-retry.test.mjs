// HTTP-level Claude capacity failures arrive before a response body is sent to
// the caller. VDM must retry them on the SAME account, then retain the original
// error with a retry hint instead of rotating accounts or misclassifying quota.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { UPSTREAM_RETRY_BACKOFF_MS, getUpstreamRetryPlan, isRetryableUpstreamStatus } from '../lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Normalised to LF on read. These tests slice the source on "\n}\n"; if git
// checked the file out with CRLF (the Windows default) that needle never
// matches, and the failure reads "<function> is not defined" — which points at
// the code rather than at the invisible byte that actually broke it.
const src = readFileSync(join(here, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('// ── 5xx / 529: Claude capacity failure');
const end = src.indexOf('// ── 200 whose failure is inside the stream', start);
assert.ok(start >= 0 && end > start, 'upstream-capacity branch not found');
const branch = src.slice(start, end);

test('only retryable Claude capacity statuses take the upstream retry path', () => {
  for (const status of [500, 502, 503, 504, 529]) {
    assert.equal(isRetryableUpstreamStatus(status), true, `${status} should retry`);
  }
  for (const status of [400, 401, 429, 501, 505]) {
    assert.equal(isRetryableUpstreamStatus(status), false, `${status} must keep its own handler`);
  }
});

test('the capacity backoff is bounded inside VDM request deadline', () => {
  assert.deepEqual(UPSTREAM_RETRY_BACKOFF_MS, [1000, 2000, 4000]);
  assert.ok(UPSTREAM_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0) < 45_000);
});

test('a fake 529/529/200 upstream sequence retries one account, then recovers', () => {
  const fakeUpstream = [529, 529, 200];
  let retries = 0;
  const attempts = [];
  for (const status of fakeUpstream) {
    attempts.push({ account: 'same-account', status });
    const plan = getUpstreamRetryPlan(status, retries);
    if (!plan) break;
    retries = plan.attempt;
  }
  assert.deepEqual(attempts, [
    { account: 'same-account', status: 529 },
    { account: 'same-account', status: 529 },
    { account: 'same-account', status: 200 },
  ]);
  assert.equal(retries, 2);
});

test('HTTP capacity failures retry the same account and never rotate', () => {
  assert.match(branch, /const upstreamRetry = getUpstreamRetryPlan\(status, overloadRetries\);/);
  assert.match(branch, /await drainResponse\(proxyRes\);[\s\S]*await new Promise\(r => setTimeout\(r, wait\)\);[\s\S]*continue;/);
  assert.doesNotMatch(branch, /pickBestAccount|pickAnyUntried|balanceSwitch|writeKeychain/);
});

test('after the bounded retry budget, VDM preserves the upstream error and supplies Retry-After', () => {
  assert.match(branch, /if \(!retryHeaders\['retry-after'\]\) retryHeaders\['retry-after'\] = '5';/);
  assert.match(branch, /clientRes\.writeHead\(proxyRes\.statusCode, retryHeaders\)/);
});
