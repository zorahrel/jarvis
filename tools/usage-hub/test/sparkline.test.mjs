import '../test-support/isolate-tmp.mjs';
// Sparkline della scheda Account: tacche alla mezzanotte di Roma (e ogni 3 ore di Roma), etichette dentro il grafico,
// a qualunque ora. Giro 9: la griglia era alla mezzanotte UTC e dopo le 02:00 la prima etichetta usciva a sinistra,
// così la barra era rossa ogni giorno dalle ~10:55 a mezzanotte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/vdm-tabs.js'), 'utf8');
const a = src.indexOf('const ROME = '), b = src.indexOf('\n}\n', src.indexOf('function sparkline(')) + 3;
// il pezzo gira nel browser: lo si valuta qui da solo, è codice del repo
const { sparkline } = new Function(src.slice(a, b) + '\nreturn { sparkline };')();

const at = (iso, fn) => { const real = Date.now; Date.now = () => Date.parse(iso); try { return fn(); } finally { Date.now = real; } };
const romeHour = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)));
const W = 320;

// 24/10 ora legale (UTC+2), 25/10 il giorno del cambio, 26/10 ora solare (UTC+1)
const clocks = ['2026-10-24T01:00:00+02:00', '2026-10-24T02:30:00+02:00', '2026-10-24T11:00:00+02:00', '2026-10-24T23:30:00+02:00',
  '2026-10-25T02:30:00+01:00', '2026-10-26T01:00:00+01:00', '2026-10-26T11:00:00+01:00', '2026-10-26T23:30:00+01:00'];

for (const iso of clocks) {
  test(`sparkline alle ${iso}: tacche all'ora di Roma, etichette dentro il viewBox`, () => {
    for (const [windowMs, hours] of [[7 * 86400000, false], [5 * 3600000, true]]) {
      const svg = at(iso, () => sparkline([], 'x', windowMs, hours));
      const now = Date.parse(iso), t0 = now - windowMs;
      const xs = [...svg.matchAll(/<line x1="([-\d.]+)"/g)].map((m) => Number(m[1]));
      assert.ok(xs.length >= (hours ? 1 : 6), `${iso} ${hours ? '5 ore' : '7 giorni'}: tacche ${xs.length}`);
      for (const x of xs) {
        assert.ok(x >= 0 && x <= W, `tacca fuori dal grafico a x=${x}`);
        const t = t0 + (x / W) * windowMs, h = romeHour(t);
        // la tacca cade su mezzanotte (o su un'ora multipla di 3) di Roma, al decimale di x
        assert.ok(hours ? h % 3 === 0 || h % 3 === 2 : h === 0 || h === 23, `${iso}: tacca alle ${h} di Roma (x=${x})`);
      }
      for (const m of svg.matchAll(/<text x="([-\d.]+)"[^>]*>([^<]*)</g)) {
        const x = Number(m[1]);
        assert.ok(x >= 8 && x <= W - 8, `${iso}: etichetta «${m[2]}» a x=${x}, tocca o esce dal bordo`);
      }
    }
  });
}

test('sparkline: alle 11:00 di Roma la prima tacca dei 7 giorni è la mezzanotte di Roma, non le 02:00', () => {
  const iso = '2026-10-24T11:00:00+02:00', windowMs = 7 * 86400000;
  const svg = at(iso, () => sparkline([], 'x', windowMs, false));
  const x0 = Number(svg.match(/<line x1="([-\d.]+)"/)[1]);
  const t = Date.parse(iso) - windowMs + (x0 / W) * windowMs;
  // x ha un decimale: su 7 giorni vale ~3 minuti, la tolleranza è di 5
  assert.ok(Math.abs(t - Date.parse('2026-10-17T22:00:00Z')) < 5 * 60000, `prima tacca ${new Date(t).toISOString()}`);
});
