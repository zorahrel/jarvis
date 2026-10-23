import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodesign, assess, parseListen, riskyPlace, scriptOf, createTrustAlert, SUSTAINED_MS } from '../src/trust.mjs';

test('parseCodesign: Apple, sviluppatore, adhoc, nessuna', () => {
  assert.equal(parseCodesign('Authority=Software Signing\nAuthority=Apple Root CA').signer, 'apple');
  const d = parseCodesign('Authority=Developer ID Application: Discord, Inc. (53Q6R32WPB)\nTeamIdentifier=53Q6R32WPB');
  assert.deepEqual([d.signer, d.authority, d.team], ['sviluppatore', 'Discord, Inc. (53Q6R32WPB)', '53Q6R32WPB']);
  assert.equal(parseCodesign('Signature=adhoc\nTeamIdentifier=not set').signer, 'adhoc');
  assert.equal(parseCodesign('/tmp/x: code object is not signed at all').signer, 'nessuna');
});

test('assess: grave solo con due segnali, i firmati non scattano per rete o CPU', () => {
  const now = 1e12, home = '/Users/x';
  const miner = { path: '/tmp/xmr/x', sign: { signer: 'nessuna' }, listen: [], hotSince: now - SUSTAINED_MS, home };
  assert.equal(assess(miner, { now }).level, 'grave');
  assert.equal(assess({ ...miner, hotSince: now - 60000 }, { now }).level, 'attenzione');   // in /tmp ma non ancora caldo da 10 min
  assert.equal(assess({ path: '/tmp/gone', deleted: true, listen: ['*:12411'], home }, { now }).level, 'grave');
  assert.equal(assess({ path: '/opt/homebrew/bin/bun', sign: { signer: 'adhoc' }, listen: ['*:3333'], home }, { now }).level, 'attenzione');
  const signed = assess({ path: '/Applications/S.app/Contents/MacOS/S', sign: { signer: 'sviluppatore' }, listen: ['*:1'], hotSince: 0, home }, { now });
  assert.equal(signed.level, 'ok'); assert.match(signed.reasons.join(), /in ascolto/);
  // un'app aggiornata su disco gira dalla copia vecchia: si dice, non è un allarme (la porta aperta resta un'attenzione)
  assert.equal(assess({ path: '/Applications/T.app/Contents/MacOS/T', deleted: true, listen: [], home }, { now }).level, 'ok');
  assert.equal(assess({ path: '/Applications/T.app/Contents/MacOS/T', deleted: true, listen: ['*:9'], home }, { now }).level, 'attenzione');
});

test('parseListen: conta solo chi ascolta fuori dal Mac', () => {
  const m = parseListen('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nbun 34732 z 9u IPv6 0x1 0t0 TCP *:3333 (LISTEN)\nnode 5 z 9u IPv4 0x1 0t0 TCP 127.0.0.1:3360 (LISTEN)\nx 6 z 9u IPv6 0x1 0t0 TCP [::1]:9 (LISTEN)');
  assert.deepEqual([...m.entries()], [[34732, ['*:3333']]]);
});

test('riskyPlace e scriptOf', () => {
  assert.equal(riskyPlace('/private/var/folders/ab/cd/T/x', '/Users/x'), 'cartella temporanea');
  assert.equal(riskyPlace('/Users/x/Downloads/a', '/Users/x'), 'Download');
  assert.equal(riskyPlace('/opt/homebrew/bin/node', '/Users/x'), null);
  assert.equal(scriptOf('node /tmp/a/run.mjs --x'), '/tmp/a/run.mjs');
  assert.equal(scriptOf('/Applications/X.app/Contents/MacOS/X -psn'), null);
});

test('createTrustAlert: un messaggio per eseguibile al giorno, solo i gravi', async () => {
  const sent = []; let t = 0;
  const alert = createTrustAlert({ send: async (m) => sent.push(m), now: () => t });
  const g = { level: 'grave', name: 'x', pid: 1, path: '/tmp/x', reasons: ['r'] };
  assert.equal(await alert([g, { ...g, level: 'attenzione', path: '/a' }]), 1);
  assert.equal(await alert([g]), 0);
  t = 86400001; assert.equal(await alert([g]), 1);
  assert.equal(sent.length, 2);
});

test('createTrustAlert: il registro su file sopravvive al riavvio', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trust-')), 'sent.json');
  const g = { level: 'grave', name: 'x', pid: 1, path: '/tmp/x', reasons: ['r'] };
  assert.equal(await createTrustAlert({ send: async () => {}, now: () => 5, file })([g]), 1);
  assert.equal(await createTrustAlert({ send: async () => {}, now: () => 10, file })([g]), 0);
});
