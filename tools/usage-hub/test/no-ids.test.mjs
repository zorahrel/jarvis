import '../test-support/isolate-tmp.mjs';
// Nessun id in pagina: chiavi di sessione OpenClaw, cartelle local_<uuid>, JID WhatsApp e uuid dei cron diventano parole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bucketName, readCronNames } from '../src/openclaw.mjs';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
require('../public/pages-view.js'); require('../public/automations-view.js');
const PV = globalThis.PagesView, AV = globalThis.AutomationsView;
const ID = /[0-9a-f]{8}-[0-9a-f]{4}-|\b[0-9a-f]{8}\b|@g\.us|<<<|local_/i;

test('bucketName: cron senza nome, sottoagente con marcatori, gruppo con JID → niente id', () => {
  assert.equal(bucketName({ kind: 'cron', ref: 'f1933c88-1111-2222-3333-444455556666' }, { cronNames: {} }), 'openclaw/cron:automazione senza nome');
  assert.equal(bucketName({ kind: 'sub', ref: '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>' }), 'openclaw/sub:senza-etichetta');
  const wa = bucketName({ kind: 'wa-group', ref: '120363000000000000@g.us', subject: 'whatsapp:g-120363000000000000@g.us' });
  assert.doesNotMatch(wa, /@g\.us|whatsapp:g-/); assert.match(wa, /^openclaw\/wa:gruppo-/);
  assert.equal(bucketName({ kind: 'cron', ref: 'a'.repeat(8) + '-1111-2222-3333-444455556666' }, { cronNames: { ['a'.repeat(8) + '-1111-2222-3333-444455556666']: 'brief-mattutino' } }), 'openclaw/cron:brief-mattutino');
});

test('readCronNames: CLI in timeout → ultima copia su disco, non pezzi di uuid', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cron-')), 'names.json');
  fs.writeFileSync(file, JSON.stringify({ 'f1933c88-1111-2222-3333-444455556666': 'riflessione-regole' }));
  const names = await readCronNames({ maxAgeMs: 0, file, run: (_c, _a, _o, cb) => cb(new Error('timeout')) });
  assert.equal(names['f1933c88-1111-2222-3333-444455556666'], 'riflessione-regole');
});

test('humanProject: ogni forma di chiave diventa parole senza id', () => {
  const names = ['local_5d58bb9d-5000-4466-ac64-6a505dba24a6', 'openclaw/cron:f1933c88', 'openclaw/cron:automazione senza nome', 'openclaw/cron:riflessione-regole',
    'openclaw/sub:<<<END_OPENCLAW_INTERNAL_CONTEXT>>>', 'openclaw/sub:senza-etichetta', 'openclaw/sub:Zeno: terzo giro', 'openclaw/wa:whatsapp:g-120363000000000000@g.us',
    'openclaw/wa:P25', 'openclaw/discord:#zeno', 'openclaw/heartbeat', 'openclaw/altro', 'openclaw/lavoro:zenocms', 'hub-ux-cd1b30', 'progetto 6a505dba-ac64-4466-5000-5d58bb9d0000'];
  for (const n of names) {
    const h = PV.humanProject(n);
    assert.doesNotMatch(h, ID, `${n} → ${h}`);
    assert.ok(h.length > 2, n);
  }
  assert.equal(PV.humanProject('openclaw/discord:#zeno'), 'Discord #zeno');
  assert.equal(PV.humanProject('local_5d58bb9d-5000-4466-ac64-6a505dba24a6'), 'Sessione di Claude desktop');
});

test('Automazioni, dettagli tecnici: niente «Chiave cron:<uuid>», il sistema per nome', () => {
  const model = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/automations/model-problemi.json'), 'utf8'));
  const c = Object.values(model.cards).find((x) => /^cron:[0-9a-f-]{36}$/.test(x.key) && x.level !== 'nascosto') || Object.values(model.cards)[0];
  const html = AV.render(model, { now: model.checkedAt, sel: c.key });
  const tech = html.slice(html.indexOf('Dettagli tecnici'));
  assert.ok(tech.length > 20, 'pannello aperto con i dettagli');
  assert.doesNotMatch(tech, /<dt>Chiave<\/dt>/);
  assert.doesNotMatch(tech, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});
