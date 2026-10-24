#!/usr/bin/env node
// Il registro attività del proxy VDM vero prima e dopo i test. Ogni voce nuova è rossa, salvo quelle che il proxy
// scrive da solo mentre serve le sessioni vere (traffico via logEvent, rinnovo dei token): i loro tipi si leggono dal
// sorgente del VDM, così un tipo nuovo scritto da un'API resta rosso senza toccare questo file. Registro illeggibile =
// rosso (giro 9: un catch dava 0 voci e quindi verde).
//   node scripts/vdm-log-guard.mjs snap  <activity-log.json> <copia>
//   node scripts/vdm-log-guard.mjs check <activity-log.json> <copia>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, log, snap] = process.argv.slice(2);
const fail = (m) => { console.log('FAIL ' + m); process.exit(1); };
const read = (f) => {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { fail(`registro VDM illeggibile (${f}): ${e.message}`); }
  const arr = Array.isArray(j) ? j : j && j.log;
  if (!Array.isArray(arr)) fail(`registro VDM senza elenco di voci (${f})`);
  return arr;
};

if (mode === 'snap') { read(log); fs.copyFileSync(log, snap); process.exit(0); }
if (mode !== 'check') { console.error('uso: vdm-log-guard.mjs snap|check <log> <copia>'); process.exit(2); }

const before = new Set(read(snap).map((e) => JSON.stringify(e)));
const fresh = read(log).filter((e) => !before.has(JSON.stringify(e)));
const src = fs.readFileSync(path.join(ROOT, 'modules/vdm/dashboard.mjs'), 'utf8');
const own = new Set([...src.matchAll(/logEvent\('([a-z0-9_-]+)'/g)].map((m) => m[1]));
for (const t of ['token-refreshed', 'refresh-failed', 'account-discovered']) own.add(t);   // keychain, senza chiamate API
// inband-retry passa { type: peek.errorType } e il tipo scritto diventa l'errore (overloaded_error, api_error)
const inband = src.match(/INBAND_RETRY_ERRORS = new Set\(\[([^\]]*)\]/);
for (const m of (inband ? inband[1] : '').matchAll(/'([a-z_]+)'/g)) own.add(m[1]);
if (own.size < 10) fail(`tipi del proxy non letti dal sorgente (${own.size}): il filtro non è affidabile`);
const bad = fresh.filter((e) => !own.has(e.type));
if (bad.length) fail(`${bad.length} voci nuove nel registro del proxy VDM vero durante i test: ${bad.slice(0, 4).map((e) => e.type + (e.name ? ' ' + e.name : '')).join(', ')}`);
console.log(`ok   registro del proxy VDM vero: nessuna voce scritta dai test (${fresh.length} voci del traffico vero nel frattempo)`);
