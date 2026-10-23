import '../test-support/isolate-tmp.mjs';
// «Da cambiare» passa a un agente: un voto cambia crea esattamente una voce in coda, con chiave e nota.
// E i tre aperti noti della fixture si vedono uguali dalla CLI e dalla scheda in --demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auto-queue-'));
process.env.USAGE_HUB_QUEUE = path.join(dir, 'queue.json');
process.env.USAGE_HUB_OPERATORE = 'operatore-test';
const { createServer } = await import('../src/server.mjs');
const { createDemoAutomations } = await import('../src/automations/demo.mjs');
const { loadQueue } = await import('../src/queue.mjs');

async function withServer(auto, fn) {
  const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] } }, { noLive: true, automations: auto });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('un voto «cambia» produce 1 voce in coda con chiave e nota; un «ok» nessuna', () => withServer(createDemoAutomations({ fixture: 'problemi', dir: path.join(dir, 'fb') }), async (base) => {
  const post = (b) => fetch(base + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  await post({ kind: 'vote', key: 'launchd:com.esempio.aggiornamento', v: 'ok' });
  assert.equal(loadQueue().length, 0);
  const r = await post({ kind: 'vote', key: 'launchd:com.esempio.aggiornamento', v: 'cambia', note: 'avvisami solo dopo due notti di fila' });
  const q = loadQueue();
  assert.equal(q.length, 1);
  assert.match(q[0].task, /launchd:com\.esempio\.aggiornamento/);
  assert.match(q[0].task, /avvisami solo dopo due notti di fila/);
  assert.match(q[0].task, new RegExp(`"ref":"${r.row.id}"`), 'il prompt dice come chiudere con resolve');
  assert.equal(r.queued.id, q[0].id);
}));

test('tre aperti noti: la CLI ne vede 3 e la scheda in --demo sulla stessa cartella anche', async () => {
  const fx = path.join(root, 'test/fixtures/feedback-3-aperti');
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(root, 'bin/usage-hub.mjs'), 'feedback', '--open', '--json'], { encoding: 'utf8', env: { ...process.env, USAGE_HUB_FEEDBACK_DIR: fx } }));
  assert.equal(cli.length, 3);
  const m = await createDemoAutomations({ fixture: 'ok', dir: fx }).model();
  assert.equal(m.feedbackOpen, 3);
});
