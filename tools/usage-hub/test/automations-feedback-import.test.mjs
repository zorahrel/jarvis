import '../test-support/isolate-tmp.mjs';
// L'import del giudizio vecchio non perde niente: conferme identiche, e cron-health dà le stesse righe
// leggendo silenzi e correzioni dal feedback invece che dai due JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { legacyRows } from '../src/automations/legacy.mjs';
import { append, readAll, buildState, fixesForHealth, mutesAsAccepted } from '../src/automations/feedback.mjs';

process.env.USAGE_HUB_OPERATORE = 'operatore-test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures', f), 'utf8'));
const accept = fx('cron-health/accept.json'), fixes = fx('cron-health/fixes.json'), conferme = fx('feedback-import/conferme.json');

function importedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-import-'));
  for (const r of legacyRows({ conferme, accept, fixes, migrations: [{ from: 'cron:vecchio', to: 'cron:nuovo', why: 'rifatto con un id nuovo' }] })) append(r, { dir });
  return dir;
}

test('le conferme dell\'artifact diventano voti identici (key, v, at, fp)', () => {
  const pick = (x) => ({ key: x.key || x.doc_id, v: x.v, at: x.at, fp: x.fp ?? null });
  const sort = (a) => a.map(pick).sort((x, y) => x.key.localeCompare(y.key));
  const rows = readAll({ dir: importedDir() }).rows.filter((r) => r.src === 'artifact');
  assert.deepEqual(sort(rows), sort(conferme));
});

test('silenzi e correzioni importati sono gli stessi dei due JSON', () => {
  const state = buildState(readAll({ dir: importedDir() }).rows);
  assert.deepEqual(mutesAsAccepted(state), accept);
  assert.deepEqual(fixesForHealth(state).map((f) => ({ ...f, at: Date.parse(f.at) })), fixes.map((f) => ({ ...f, at: Date.parse(f.at) })));
});

test('cron-health sugli input congelati: stesse righe prima (JSON) e dopo (feedback importato)', () => {
  const before = fx('cron-health/before.json').accepted;
  const lines = before.length ? [`Automazioni OpenClaw: ${before.length} ${before.length === 1 ? 'cosa' : 'cose'} da sistemare`, ...before.map((o) => `• [${o.kind}] ${o.line}`)] : [];
  const out = execFileSync(process.execPath, [path.join(root, 'bin/cron-health.mjs')], {
    encoding: 'utf8', env: { ...process.env, CRON_HEALTH_FACTS: path.join(root, 'test/fixtures/cron-health/facts.json'), USAGE_HUB_FEEDBACK_DIR: importedDir() },
  });
  assert.deepEqual(out.trimEnd().split('\n'), lines);
});
