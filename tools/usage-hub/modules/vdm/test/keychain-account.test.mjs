// A blank Claude Code-credentials item under another account must not shadow
// the one vdm writes under currentUser(): the 2026-09-11 incident, where a
// service-only lookup returned the blank item for 35 hours.
import '../../../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..', 'platform.mjs');

test('the item under our own account wins over a blank one met first', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vdm-keychain-'));
  const shim = join(dir, 'security');
  writeFileSync(shim, `#!/bin/bash
acct=""; prev=""
for a in "$@"; do [ "$prev" = "-a" ] && acct="$a"; prev="$a"; done
case "$acct" in
  vdm-test) echo '{"claudeAiOauth":{"accessToken":"live-access","refreshToken":"live-refresh","expiresAt":9999999999999}}' ;;
  ""|unknown) echo '{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0}}' ;;
  *) echo "The specified item could not be found in the keychain." >&2; exit 44 ;;
esac
`);
  chmodSync(shim, 0o755);
  const run = (user) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { readCredentials } from ${JSON.stringify(PLATFORM)}; console.log(JSON.stringify(readCredentials()));`],
    { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, USER: user } }));

  assert.equal(run('vdm-test').claudeAiOauth.accessToken, 'live-access');
  // No item under our account: the service-only lookup is still used.
  assert.equal(run('someone-else').claudeAiOauth.accessToken, '');
});
