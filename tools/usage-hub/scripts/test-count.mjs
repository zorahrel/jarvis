#!/usr/bin/env node
// Quanti test ha eseguito davvero ogni file, letti dal report junit di node --test, contro test/expected-tests.json.
// Un test che sparisce in silenzio (giro 9: registrato dopo un await di primo livello e scartato da
// --test-force-exit) fa scendere il conteggio del suo file e la barra cade.
//   node scripts/test-count.mjs check <junit.xml>   esce 1 se un file ha più o meno test del previsto
//   node scripts/test-count.mjs write <junit.xml>   riscrive i conteggi (dopo aver aggiunto o tolto test apposta)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = path.join(ROOT, 'test/expected-tests.json');
const [mode, junit] = process.argv.slice(2);
if (!['check', 'write'].includes(mode) || !junit) { console.error('uso: test-count.mjs check|write <junit.xml>'); process.exit(2); }

const xml = fs.readFileSync(junit, 'utf8');
const got = {};
for (const m of xml.matchAll(/<testcase\b([^>]*)>/g)) {
  // alcuni casi (sottotest) non hanno file: contano sotto «(senza file)», così anche la loro sparizione si vede
  const fm = m[1].match(/\bfile="([^"]+)"/);
  if (!fm) { got['(senza file)'] = (got['(senza file)'] || 0) + 1; continue; }
  // il percorso assoluto cambia da copia a copia: conta quello relativo alla cartella dell'hub
  const abs = fm[1].replace(/&amp;/g, '&');
  const i = abs.lastIndexOf('/tools/usage-hub/');
  const rel = i >= 0 ? abs.slice(i + '/tools/usage-hub/'.length) : path.relative(ROOT, abs);
  got[rel] = (got[rel] || 0) + 1;
}
const total = Object.values(got).reduce((a, b) => a + b, 0);
if (!total) { console.log('FAIL nessun test nel report junit: il giro non è partito o il report è vuoto'); process.exit(1); }

if (mode === 'write') {
  const sorted = Object.fromEntries(Object.keys(got).sort().map((k) => [k, got[k]]));
  fs.writeFileSync(EXPECTED, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`scritti ${Object.keys(got).length} file, ${total} test`);
  process.exit(0);
}

const want = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
const bad = [];
for (const f of new Set([...Object.keys(want), ...Object.keys(got)])) {
  if (want[f] === got[f]) continue;
  if (want[f] == null) bad.push(`${f}: ${got[f]} test, file nuovo non in expected-tests.json`);
  else if (got[f] == null) bad.push(`${f}: attesi ${want[f]}, non eseguito`);
  else bad.push(`${f}: attesi ${want[f]}, eseguiti ${got[f]}`);
}
const wantTotal = Object.values(want).reduce((a, b) => a + b, 0);
if (bad.length) {
  console.log(`FAIL test eseguiti diversi dal previsto (${total} su ${wantTotal}); se è voluto: node scripts/test-count.mjs write <junit>`);
  for (const b of bad.slice(0, 12)) console.log('     ' + b);
  process.exit(1);
}
console.log(`ok   ${total} test eseguiti, uguali ai previsti file per file (${Object.keys(want).length} file)`);
