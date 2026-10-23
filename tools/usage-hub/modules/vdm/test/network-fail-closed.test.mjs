// A TCP/DNS timeout is independent of the OAuth bearer token.  VDM must retry
// the selected account once, then return a retryable error; changing account or
// forwarding the caller's original auth silently bypasses the account proxy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('    if (lastNetworkError) {');
const end = src.indexOf('\n    const status = proxyRes.statusCode;', start);
assert.ok(start >= 0 && end > start, 'network-error branch not found');
const branch = src.slice(start, end);

test('transport errors remain fail-closed through VDM', () => {
  assert.doesNotMatch(branch, /_passthroughFallback|_smartPassthrough/);
  assert.doesNotMatch(branch, /pickBestAccount|pickAnyUntried|balanceSwitch|writeKeychain/);
  assert.match(branch, /clientRes\.writeHead\(503/);
  assert.match(branch, /'Retry-After': '1'/);
  assert.match(branch, /retry through VDM/);
});
