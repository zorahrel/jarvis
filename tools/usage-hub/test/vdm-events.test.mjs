import '../test-support/isolate-tmp.mjs';
// Attività: ogni tipo di evento che il proxy VDM scrive davvero ha la sua frase in EVT (public/vdm-tabs.js).
// I tipi si leggono dal sorgente del proxy, così un evento nuovo senza traduzione fa cadere il test invece di
// finire in pagina come «Evento del proxy (cap hold)» (giro 9: undici tipi mancavano).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vdmSrc = fs.readFileSync(path.join(root, 'modules/vdm/dashboard.mjs'), 'utf8');
const tabs = fs.readFileSync(path.join(root, 'public/vdm-tabs.js'), 'utf8');

function emitted() {
  const t = new Set();
  for (const m of vdmSrc.matchAll(/\blog(?:Event|Activity)\('([a-z0-9_-]+)'/g)) t.add(m[1]);
  // inband-retry passa { type: errorType }: nel registro il tipo diventa l'errore stesso
  const inband = vdmSrc.match(/INBAND_RETRY_ERRORS = new Set\(\[([^\]]*)\]/);
  for (const m of (inband ? inband[1] : '').matchAll(/'([a-z_]+)'/g)) t.add(m[1]);
  return t;
}
function evtKeys() {
  const a = tabs.indexOf('const EVT = {'), b = tabs.indexOf('\n};', a);
  assert.ok(a > 0 && b > a, 'EVT non trovato in vdm-tabs.js');
  return new Set([...tabs.slice(a, b).matchAll(/^\s*'?([a-z0-9_-]+)'?:\s*\[/gm)].map((m) => m[1]));
}

test('ogni tipo di evento che il proxy VDM scrive ha la sua frase in Attività', () => {
  const types = emitted(), keys = evtKeys();
  assert.ok(types.size >= 25, `tipi letti dal proxy: ${types.size}, troppo pochi per fidarsi della lettura`);
  const missing = [...types].filter((t) => !keys.has(t)).sort();
  assert.deepEqual(missing, [], `tipi senza frase in EVT: ${missing.join(', ')}`);
});

test('le frasi di Attività usano l\'etichetta dell\'account, non il nome interno del profilo', () => {
  // EVT gira nel browser: lo si valuta qui con esc e L finti, L marca ciò che passa dall'etichetta
  const a = tabs.indexOf('const mins = '), b = tabs.indexOf('\n};', tabs.indexOf('const EVT = {')) + 3;
  const EVT = new Function('esc', tabs.slice(a, b) + '\nreturn EVT;')((s) => String(s));
  const L = (x) => `«${x}»`;
  const sample = { name: 'auto-2', account: 'auto-2', from: 'auto-1', to: 'auto-2', capped: ['auto-1'], label: '', priority: 1, fiveH: 63, sevenD: 64, retryAfter: 120, model: 'opus', attempt: 2, status: 529, enabled: true, cap: 4, consecutive: 2 };
  for (const [type, [, f]] of Object.entries(EVT)) {
    const html = f(type === 'upgrade' ? { to: '2.1.0' } : sample, L);   // upgrade.to è una versione, non un account
    assert.doesNotMatch(html.replace(/«auto-\d»/g, ''), /auto-\d/, `${type}: nome interno senza etichetta in «${html}»`);
    assert.doesNotMatch(html.replace(/«[^»]*»/g, 'X').replace(/<[^>]+>/g, ' '), /\b[a-z]+(?:[-_][a-z0-9]+)+\b/, `${type}: chiave grezza in «${html}»`);
  }
});
