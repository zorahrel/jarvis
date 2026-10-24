import '../test-support/isolate-tmp.mjs';
// Gli id della demo e delle fixture sono finti per costruzione: ogni token che ha la forma di un id (uuid, local_…,
// _sys_…, esadecimale da 8 in su) dev'essere in questo elenco. Giro 9: rimettere in demo-vdm.mjs gli id veri di una
// cartella di Claude desktop e di una cartella di sistema lasciava verde tutta la barra, perché la pagina li traduce in
// parole e la sandbox non conosce gli id veri. Un id nuovo si aggiunge qui solo se è inventato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = new Set(['local_0e5a1d2c-1111-4222-8333-944455556666', '_sys_a1b2c3d4', 'aa11bb22']);
// uuid delle fixture dei cron: tutti uguali tranne il contatore finale
const FAKE_RE = /^11111111-aaaa-4000-8000-0000000000\d\d$/;
const ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|local_[0-9a-f-]{8,}|_sys_[0-9a-f]{4,}|(?<![\w-])[0-9a-f]{8,}(?![\w-])/gi;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sources = () => [
  ...fs.readdirSync(path.join(root, 'src')).filter((f) => /^demo.*\.mjs$/.test(f)).map((f) => path.join(root, 'src', f)),
  path.join(root, 'src/automations/demo.mjs'),
  ...walk(path.join(root, 'test/fixtures/automations')).filter((f) => /\.(json|jsonl|mjs|js)$/.test(f)),
];

test('demo e fixture: ogni id è uno di quelli inventati', () => {
  const files = sources();
  assert.ok(files.length >= 8, `file letti: ${files.length}`);
  const bad = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(ID_RE)) {
      const id = m[0];
      if (/^\d+$/.test(id) || FAKE.has(id) || FAKE_RE.test(id)) continue;
      bad.push(`${path.relative(root, f)}: ${id}`);
    }
  }
  assert.deepEqual(bad, [], 'id non nell\'elenco dei finti');
});
