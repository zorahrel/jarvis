// Regression test per le icone di barra: fondo trasparente, inchiostro
// centrato e che riempie lo spazio, foro centrale per openai (il knot a 8px
// diventa un cerchio pieno se il foro si chiude — visto il 2026-10-07).
// Zero dipendenze: parser PNG minimo (RGBA 8bit, non interlacciato).
// Esecuzione: node --test assets/bar-icons.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

function readRGBA(path) {
    const buf = readFileSync(path);
    assert(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'not a PNG');
    let pos = 8, w = 0, h = 0, colorType = 0, bitDepth = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9];
            assert.equal(data[12], 0, 'interlaced PNG unsupported');
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        pos += 12 + len;
    }
    assert.equal(bitDepth, 8, 'bit depth');
    assert.equal(colorType, 6, 'want RGBA');
    const raw = inflateSync(Buffer.concat(idat));
    const ch = 4, stride = w * ch;
    const px = Buffer.alloc(w * h * ch);
    let p = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[p++];
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? px[y * stride + x - ch] : 0;
            const b = y > 0 ? px[(y - 1) * stride + x] : 0;
            const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
            let v = raw[p++];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) {
                const q = a + b - c;
                const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            px[y * stride + x] = v & 255;
        }
    }
    return { w, h, px };
}

const alpha = (t, x, y) => t.px[(y * t.w + x) * 4 + 3];

function inkBBox(t) {
    let x0 = t.w, y0 = t.h, x1 = -1, y1 = -1;
    for (let y = 0; y < t.h; y++)
        for (let x = 0; x < t.w; x++)
            if (alpha(t, x, y) > 128) {
                x0 = Math.min(x0, x); y0 = Math.min(y0, y);
                x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
}

describe('bar icons', () => {
    for (const slug of ['anthropic', 'openai', 'meta']) {
        it(`${slug}: 72px, trasparente, inchiostro centrato e pieno`, () => {
            const t = readRGBA(join(dir, `bar-${slug}.png`));
            assert.equal(t.w, 72);
            assert.equal(t.h, 72);
            for (const [x, y] of [[0, 0], [71, 0], [0, 71], [71, 71]])
                assert.equal(alpha(t, x, y), 0, `angolo (${x},${y}) non trasparente`);
            const bb = inkBBox(t);
            assert(bb, 'inchiostro vuoto');
            const cy = (bb.y0 + bb.y1) / 2;
            assert(Math.abs(cy - 35.5) <= 3, `inchiostro non centrato: cy=${cy}`);
            assert(bb.y1 - bb.y0 >= 40, 'inchiostro troppo piccolo in altezza');
            assert(bb.x1 - bb.x0 >= 20, 'inchiostro troppo piccolo in larghezza');
        });
    }
    it('openai: a 8px il foro resta aperto e l’anello visibile', () => {
        // Media alpha su blocchi 9x9 (= un pixel a 8px): il foro del master
        // a 72px sparisce comunque in downscale se è troppo stretto.
        const t = readRGBA(join(dir, 'bar-openai.png'));
        const cell = (cx, cy) => {
            let s = 0;
            for (let y = cy * 9; y < cy * 9 + 9; y++)
                for (let x = cx * 9; x < cx * 9 + 9; x++) s += alpha(t, x, y);
            return s / 81;
        };
        // Nodo vero h56 + foro esagonale: 2x2 centrale < 90 (ora ~54;
        // disco pieno ~255) e almeno 8 blocchi pieni (ora 10; icona
        // invisibile = 0). Trama delicata = pochi blocchi pieni per natura.
        const hole = Math.max(cell(3, 3), cell(4, 3), cell(3, 4), cell(4, 4));
        assert(hole < 90, `foro chiuso a 8px: ${hole}`);
        let solid = 0;
        for (let cy = 0; cy <= 7; cy++)
            for (let cx = 0; cx <= 7; cx++)
                if (cell(cx, cy) > 120) solid++;
        assert(solid >= 8, `nodo invisibile a 8px: ${solid} blocchi pieni`);
    });
});
