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

test('projectName: cartelle con un id (local_, wf_, _sys_, uuid) arrivano alle API già come parole', async () => {
  const { projectName } = await import('../src/usage.mjs');
  for (const cwd of ['/x/local_5d58bb9d-5000-4466-ac64-6a505dba24a6', '/tmp/wf_233cc80c-e78-1', '/y/_sys_226619bc', '/z/run-7e1ab828-1d47-4d5f-bf35-919a0043ea64'])
    assert.doesNotMatch(projectName('-d', cwd, []), ID, cwd);
  assert.equal(projectName('-d', '/x/local_5d58bb9d-5000-4466-ac64-6a505dba24a6', []), 'Sessioni di Claude desktop');
  assert.equal(projectName('-d', '/x/armonia-site', []), 'armonia-site');
});

test('testi liberi senza id: «Ti scrive», messaggi delle sessioni, cartelle _sys_ (casi del 24/10)', () => {
  const LONG = /\d{9,}|<<<|[0-9a-f]{8}-[0-9a-f]{4}-/i;
  const cases = ['WhatsApp, nel gruppo con id 120363411359994568, lunedì alle 9:00, solo se qualcosa è cambiato',
    'Discord (canale 1547285789002698864), il 2 del mese alle 9:00',
    '<<<BEGIN_OPENCLAW_INTERNAL_CONT…', 'scrive in 120363411359994568@g.us'];
  for (const t of cases) assert.doesNotMatch(PV.sessionText(t), LONG, t);
  assert.equal(AV.noIds(cases[0]), 'WhatsApp, nel gruppo, lunedì alle 9:00, solo se qualcosa è cambiato');
  assert.equal(AV.noIds(cases[1]), 'Discord, il 2 del mese alle 9:00');
  assert.equal(PV.sessionPlace({ cwd: '/Users/x/.openclaw/_sys_226619bc' }), 'Cartella di sistema');
  assert.equal(PV.sessionPlace({ repo: 'armonia-site', branch: 'main' }), 'armonia-site/main');
  // il pannello di un'automazione non mostra l'id del gruppo in «Ti scrive»
  const html = AV.card({ key: 'cron:x', title: 'Prova', provider: 'openclaw', level: 'va', last: {}, means: cases[0], who: 'Jarvis (canale 1547285789002698864)' }, {}, Date.now());
  assert.match(html, /Ti scrive/); assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /\d{12,}/);
});

test('cronologia delle sessioni: niente testo interno di OpenClaw, orari tra parentesi, nomi mcp__ e percorsi (24/10)', () => {
  const INTERNAL = /acknowledge|inter-session|routing data|GMT[+-]\d|mcp__|\/Users\/|\d{9,}/i;
  const cases = ['I acknowledge this is an inter-session message routed from Discord channel 1551637216177168465.',
    'This message appears to be inter-session routing data, not a request from the user.',
    '[Sat 2026-10-24 02:56 GMT+2] controlla la quota di Codex',
    'mcp__openclaw__process', 'mcp__openclaw__exec: date; ls /Users/zorahrel/.openclaw/workspace/memory',
    'Editing /Users/zorahrel/.claude/jarvis/tools/usage-hub/public/vdm-tabs.js'];
  for (const t of cases) assert.doesNotMatch(PV.sessionText(t), INTERNAL, t);
  assert.equal(PV.sessionText(cases[0]), 'Messaggio di servizio fra sessioni');
  assert.equal(PV.sessionText(cases[1]), 'Messaggio di servizio fra sessioni');
  assert.equal(PV.sessionText(cases[2]), 'controlla la quota di Codex');
  assert.equal(PV.sessionText(cases[3]), 'Strumento di openclaw: process');
  assert.equal(PV.sessionText(cases[4]), 'Strumento di openclaw: exec: date; ls …/workspace/memory');
  assert.equal(PV.sessionText(cases[5]), 'Editing …/public/vdm-tabs.js');
});

test('pannello di un\'automazione: numeri di account nei dettagli tecnici e nello schema diventano parole (24/10)', () => {
  const html = AV.card({ key: 'cron:x', title: 'Prova', provider: 'openclaw', level: 'va', last: {}, means: 'x',
    tech: { command: 'aws s3 ls --profile account 767397818599\n  poi  copia' } }, {}, Date.now());
  const txt = html.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(txt, /767397818599/);
  assert.match(html, /account\n {2}poi {2}copia|account\s*\n/, 'nel <pre> gli a capo restano');
  const g = AV.graphHtml({ nodes: [
    { kind: 'trigger', label: 'Ogni giorno' },
    { kind: 'step', label: 'Legge', io: { in: 'controlla account 767397818599', out: 'conto 123456789012 ok' }, detail: 'utente 987654321', error: 'chat 555666777888 rifiuta' },
  ] }, Date.now());
  assert.doesNotMatch(g.replace(/<[^>]+>/g, ' '), /\d{9,}/);
});

test('diario: le chiavi delle automazioni senza scheda diventano parole, senza hash fra parentesi (24/10)', async () => {
  const { humanKey, journal } = await import('../src/journal.mjs');
  assert.equal(humanKey('health:mailwatch (ec409111): consegna spesso'), '«avviso: mailwatch: consegna spesso»');
  assert.equal(humanKey('health:doctor: plugins/delegate-router'), 'l\'avviso del doctor di OpenClaw su delegate router');
  assert.equal(humanKey('cron:7e1ab828-1d47-4d5f-bf35-919a0043ea64'), 'senza nome');
  const j = journal({ model: { cards: {} }, feedback: [{ kind: 'mute', key: 'health:mailwatch (ec409111): consegna spesso', at: Date.now() - 1000 }] });
  const t = JSON.stringify(j.map((r) => [r.title, r.what])); // ref e link servono al clic, non si leggono
  assert.doesNotMatch(t, /ec409111|health:/);
  assert.match(t, /Hai silenziato «avviso: mailwatch: consegna spesso»/);
});
