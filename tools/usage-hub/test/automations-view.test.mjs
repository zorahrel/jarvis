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

test('(b) a sistema sano ogni card sta dentro un gruppo chiuso', () => {
  assert.ok(!/<article class="au-card/.test(stripDetails(htmlOk)));
  const sec = secs(htmlOk);
  assert.ok(sec.includes('needs') && sec.includes('broken'));
  assert.match(htmlOk, /Niente ti aspetta\./);
  assert.match(htmlOk, /Niente di rotto\./);
});

test('(c) le sezioni sono sempre nello stesso ordine', () => {
  assert.deepEqual(secs(htmlOk), secs(htmlPb));
  for (const s of ['needs', 'broken', 'works', 'workflows', 'footer']) {
    assert.ok(secs(htmlOk).includes(s), s);
  }
  assert.deepEqual(secs(htmlOk), ['verdict', 'needs', 'broken', 'works', 'workflows', 'review', 'footer']);
});

test('(d) consegna mancata e prova esterna sono in parole', () => {
  assert.match(htmlPb, /non ti è arrivato/);
  // Prova mancante: la dice il motivo, una volta sola. Prova riuscita: riga «Prova:» che rassicura.
  assert.match(htmlPb, /manca la prova/);
  assert.equal(htmlPb.match(/manca la prova/g).length, 1);
  const withProof = structuredClone(pb);
  const c = withProof.broken.find((x) => x.proof);
  c.proof = { ok: true, words: 'commit del backup alle 4:33' };
  assert.match(render(withProof, { now: withProof.checkedAt }), /Prova: commit del backup alle 4:33/);
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
