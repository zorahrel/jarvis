// Parità della dashboard unica con la vecchia pagina VDM (tolta in ec631dd): ogni campo dati che la pagina leggeva deve essere letto da public/*.js.
// Se ne manca uno il test esce non zero: è il modo in cui si accorge un'altra rimozione silenziosa.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { fields } = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/vdm-page-fields.json'), 'utf8'));
const src = fs.readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'public', f), 'utf8')).join('\n');

// Un campo è letto se compare come .campo, ['campo'], "campo" (chiave in data-k) oppure campo: (chiave d'oggetto).
const reads = (f) => new RegExp(`\\.${f}\\b|\\[['"]${f}['"]\\]|['"]${f}['"]|\\b${f}\\s*:`).test(src);

test('la dashboard unica legge tutti i campi della vecchia pagina VDM', () => {
  const missing = fields.filter((f) => !reads(f));
  assert.deepEqual(missing, [], 'campi non letti da public/*.js: ' + missing.join(', '));
});
