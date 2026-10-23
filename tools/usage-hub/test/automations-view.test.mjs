import '../test-support/isolate-tmp.mjs';
// Scheda Automazioni: fuori dai dettagli tecnici niente id, codici o espressioni;
// a sistema sano le card stanno tutte chiuse nei gruppi; l'ordine delle sezioni è fisso.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Come actions.js: IIFE che in node espone module.exports; basta caricarlo.
const require = createRequire(import.meta.url);
const loaded = require('../public/automations-view.js');
const V = loaded && loaded.render ? loaded : globalThis.AutomationsView;
const { render, lastWords, deliveredWords } = V;

const ok = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/automations/model-ok.json'), 'utf8'));
const pb = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/automations/model-problemi.json'), 'utf8'));
const htmlOk = render(ok, { now: ok.checkedAt });
const htmlPb = render(pb, { now: pb.checkedAt });

// Toglie un blocco <details> con tutto ciò che contiene, anche se annidato.
function stripDetails(html) {
  const tok = /<details[\s>]|<\/details\s*>/g;
  let out = '', depth = 0, last = 0, m;
  while ((m = tok.exec(html))) {
    if (depth === 0) out += html.slice(last, m.index);
    depth += m[0][1] === '/' ? -1 : 1;
    last = tok.lastIndex;
  }
  if (depth === 0) out += html.slice(last);
  return out;
}

const secs = (h) => [...h.matchAll(/data-sec="([^"]+)"/g)].map((m) => m[1]);

// Ciò che si legge: testo e tooltip, senza i dettagli tecnici. Gli attributi data-* non si vedono.
const visible = (h) => h.replace(/<details class="tech">[\s\S]*?<\/details>/g, '')
  .replace(/<[^>]*?\btitle="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]*>/g, ' ');
const CODES = [/[0-9a-f]{8}-[0-9a-f]{4}/, /\b(com|ai)\.[a-z]+\./, /(^|\s)[\d*/,-]+ [\d*/,-]+ [\d*/,-]+ [\d*/,-]+ [\d*/,-]+(?=\s|$)/, /\bexit\b/i, /codice \d/];

test('(a) fuori dai dettagli tecnici niente id, domini, cron, exit o codici', () => {
  // Le chiavi vere hanno UUID e label launchd: la prima card ne prende una così.
  const real = structuredClone(pb);
  const c0 = real.needsYou[0];
  c0.key = 'cron:fd4c35a4-45a4-483b-b463-4491567be56c';
  c0.tech = { ...(c0.tech || {}), schedule: '45 8 * * *', exit: 1, command: 'node ~/.openclaw/bin/cron-health.mjs' };
  real.broken[0].key = 'launchd:com.jarvis.private-backup';
  for (const h of [htmlOk, htmlPb, render(real, { now: real.checkedAt })]) {
    for (const re of CODES) assert.doesNotMatch(visible(h), re);
  }
  // Il controllo non è vuoto: un codice nel motivo si vede e viene preso.
  real.needsYou[0].reason = 'uscito con exit 1';
  assert.match(visible(render(real, { now: real.checkedAt })), CODES[3]);
});

test('(b) a sistema sano nessuna card aperta: il pannello si apre solo scegliendo una riga', () => {
  assert.ok(!/<article class="au-card/.test(stripDetails(htmlOk)));
  assert.ok(!/cx-panel/.test(htmlOk));
  const key = ok.groups.flatMap((g) => g.cards)[0];
  const k = typeof key === 'string' ? key : key.key;
  const open = render(ok, { now: ok.checkedAt, sel: k });
  assert.match(open, /<aside class="cx-panel" role="dialog"/);
  // I cinque pulsanti di feedback stanno nel pannello.
  for (const fb of ['ok', 'cambia', 'nota', 'segnala', 'muta']) assert.match(open, new RegExp('data-fb="' + fb + '"'));
});

test('(c) le sezioni sono sempre nello stesso ordine', () => {
  const order = (h) => secs(h).filter((s) => s !== 'since' && s !== 'review');
  assert.deepEqual(order(htmlOk), order(htmlPb));
  assert.deepEqual(order(htmlOk), ['verdict', 'table', 'footer']);
});

test('(d) consegna mancata e prova esterna sono in parole', () => {
  const now = pb.checkedAt;
  const all = [...pb.needsYou, ...pb.broken];
  const failed = all.find((c) => c.last && c.last.delivered === 'failed');
  assert.match(V.card(failed, {}, now), /non ti è arrivato/);
  // Prova mancante: la dice il motivo, una volta sola nel pannello.
  const noProof = all.find((c) => /manca la prova/.test(c.reason || ''));
  assert.equal(V.card(noProof, {}, now).match(/manca la prova/g).length, 1);
  const c = structuredClone(all.find((x) => x.proof));
  c.proof = { ok: true, words: 'commit del backup alle 4:33' };
  assert.match(V.card(c, {}, now), /<dt>Prova<\/dt><dd class="">commit del backup alle 4:33/);
  assert.equal(deliveredWords('failed'), 'non ti è arrivato');
  assert.equal(deliveredWords('delivered'), 'ti è arrivato');
  assert.equal(deliveredWords('none'), '');
});

test('(e) lastWords nei cinque casi', () => {
  const now = ok.checkedAt; // ven 23/10/2026 ore 16:00 di Roma
  const at = (iso) => ({ at: Date.parse(iso) });
  assert.equal(lastWords(at('2026-10-23T04:32:00+02:00'), now), 'stanotte alle 4:32');
  assert.equal(lastWords(at('2026-10-23T15:02:00+02:00'), now), 'alle 15:02');
  assert.equal(lastWords(at('2026-10-22T09:30:00+02:00'), now), 'ieri alle 9:30');
  assert.equal(lastWords(at('2026-10-20T09:00:00+02:00'), now), 'martedì alle 9:00');
  assert.equal(lastWords({ at: null }, now), 'mai partito');
});

test('(f) il verdetto conta chi ti aspetta', () => {
  assert.match(htmlPb, /2 ti aspettano/);
  assert.match(htmlOk, /Tutto a posto/);
});

test('(g) gruppi per scopo, il sistema solo nel pannello', () => {
  const table = htmlPb.slice(htmlPb.indexOf('data-sec="table"'), htmlPb.indexOf('data-sec="footer"'));
  assert.doesNotMatch(visible(table), /OpenClaw|\bMac\b|launchd/);
  assert.match(table, /<div class="cx-gh">(Posta e avvisi|Backup e sicurezza)/);
  // Senza purpose l'area è stimata e lo dice.
  const c = structuredClone(pb.broken[0]);
  c.purpose = null;
  assert.match(V.card(c, {}, pb.checkedAt), /\(area stimata\)/);
  c.purpose = { area: 'clienti' };
  assert.equal(V.areaOf(c), 'clienti');
  assert.doesNotMatch(V.card(c, {}, pb.checkedAt), /area stimata/);
});

test('(h) workflow: passi con esecutore, token e risparmio; senza token niente numeri inventati', () => {
  const run = { steps: [
    { id: 'a', label: 'Legge', executor: 'free', tokens: 8000, outcome: 'ok' },
    { id: 'b', label: 'Scrive', executor: 'claude', tokens: 2000, outcome: 'ok' },
  ], tokensSavedVsClaude: 8000 };
  const t = V.runTokens(run);
  assert.equal(t.saved, 8000);
  const h = V.flowHtml(run);
  assert.match(h, /Legge/);
  assert.match(h, /x-free/);
  assert.match(h, /x-claude/);
  assert.equal(V.runTokens({ steps: [{ id: 'a', label: 'x', executor: null, tokens: null }] }), null);
  assert.equal(V.runTokens({}), null);
});
