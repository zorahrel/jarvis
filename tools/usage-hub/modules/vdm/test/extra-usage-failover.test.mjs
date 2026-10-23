// Anthropic reports an exhausted subscription allowance as a 400
// invalid_request_error: "You're out of extra usage".  It must take the
// billing/failover route, not the normal malformed-request passthrough.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAccountStateManager } from '../lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Normalised to LF on read. These tests slice the source on "\n}\n"; if git
// checked the file out with CRLF (the Windows default) that needle never
// matches, and the failure reads "<function> is not defined" — which points at
// the code rather than at the invisible byte that actually broke it.
const src = readFileSync(join(here, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');
const match = src.match(/const isBillingError = ([^;]+);/);
assert.ok(match, 'billing error classifier not found in dashboard.mjs');
const isBillingError = new Function('errorMessage', `return ${match[1]};`);
const strategy3Start = src.indexOf('// ── Strategy 3: Switch to another account ──');
const strategy4Start = src.indexOf('// ── Strategy 4 (last resort): Retry with minimal headers ──');
assert.ok(strategy3Start >= 0 && strategy4Start > strategy3Start, '400 recovery switch branches not found');
const strategy3 = src.slice(strategy3Start, strategy4Start);

test('Anthropic extra-usage exhaustion triggers VDM failover', () => {
  assert.equal(
    isBillingError("You're out of extra usage. Add more at claude.ai/settings/usage and keep going."),
    true,
  );
});

test('ordinary malformed requests still do not trigger account rotation', () => {
  assert.equal(isBillingError('messages.3: content must be non-empty'), false);
});

test('billing exhaustion never falls back to an already-limited account', () => {
  assert.match(
    strategy3,
    /isBillingError\s*\?\s*pickBestAccount\(triedTokens\)\s*:\s*\(pickBestAccount\(triedTokens\)\s*\|\|\s*pickAnyUntried\(triedTokens\)\)/s,
  );
});

test('when every selectable account is exhausted, retain Anthropic\'s real error', () => {
  assert.match(strategy3, /no selectable account remains after billing error/);
  assert.match(strategy3, /clientRes\.writeHead\(400, proxyRes\.headers\)/);
});

test('the dashboard distinguishes Extra Usage from the plan-window bars', () => {
  assert.match(src, /markAccountLimited\(token, acctName, BILLING_COOLDOWN_SEC, 'extra-usage'\)/);
  // La resa sta nella dashboard del hub (public/vdm-tabs.js), non piu' in dashboard.mjs.
  const ui = readFileSync(join(here, '..', '..', '..', 'public', 'vdm-tabs.js'), 'utf8');
  assert.match(ui, /p\.blockKind === 'extra-usage'/);
  assert.match(ui, /limiti del piano, non l\\'extra usage/);
});

test('a healthy plan probe cannot erase an expired Extra Usage marker', () => {
  const state = createAccountStateManager();
  const headers = {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.14',
    'anthropic-ratelimit-unified-7d-utilization': '0.23',
    'anthropic-ratelimit-unified-5h-reset': '9999999999',
  };
  state.update('token', 'test', headers);
  state.markLimited('token', 'test', 0, 'extra-usage');

  state.update('token', 'test', headers, { preserveExtraUsageMarker: true });
  assert.equal(state.get('token').limited, false);
  assert.equal(state.get('token').blockKind, 'extra-usage');

  // A real model response clears the marker; only a probe is deliberately
  // prevented from doing so.
  state.update('token', 'test', headers);
  assert.equal(state.get('token').blockKind, null);
});
