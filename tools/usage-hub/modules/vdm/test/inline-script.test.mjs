import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { it } from 'node:test';
import assert from 'node:assert/strict';

// Dal 18/10 la pagina VDM non esiste piu' (:3335 reindirizza al hub): la dashboard sono
// gli script classici in public/. Un errore di sintassi li' spegne tutta la pagina.
const PUB = new URL('../../../public/', import.meta.url);

it('the hub dashboard scripts are valid JavaScript', () => {
  const html = readFileSync(new URL('index.html', PUB), 'utf8');
  const srcs = [...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(srcs.length > 0, 'index.html loads no script');
  for (const s of srcs) {
    const code = readFileSync(new URL(s, PUB), 'utf8');
    assert.doesNotThrow(() => new Script(code, { filename: s }), s);
  }
});
