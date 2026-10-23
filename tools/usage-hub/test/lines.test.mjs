import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine } from '../src/lines.mjs';

test('forEachLine: solo le righe con la chiave, in ordine, una volta sola; la riga a metà resta fuori', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lines-')), 'x.jsonl');
  const lines = Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? `{"i":${i},"usage":1,"token_count":1}` : `{"i":${i},"pad":"${'x'.repeat(i % 50)}"}`));
  fs.writeFileSync(f, lines.join('\n') + '\n{"i":9999,"usage":1');
  const got = [];
  const off = forEachLine(f, ['"usage"', '"token_count"'], (l) => got.push(JSON.parse(l).i));
  assert.deepEqual(got, lines.map((_, i) => i).filter((i) => i % 3 === 0));
  assert.equal(off, fs.statSync(f).size - '{"i":9999,"usage":1'.length);
});

test('forEachLine: righe più lunghe del buffer, con e senza chiave, anche a cavallo dei blocchi e a metà', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lines-')), 'big.jsonl');
  const big = (n, key = '') => `{"pad":"${'x'.repeat(n)}"${key}}`;
  const rows = [
    '{"i":1,"usage":1}',
    big(9 * 1024 * 1024),                       // lunga, senza chiave: saltata
    big(9 * 1024 * 1024, ',"usage":2'),         // lunga, chiave in fondo: letta intera
    big(4 * 1024 * 1024 - 13, ',"usage":3'),    // chiave a cavallo del primo blocco
    '{"i":4,"usage":4}',
  ];
  fs.writeFileSync(f, rows.join('\n') + '\n' + big(5 * 1024 * 1024));
  const got = [];
  const off = forEachLine(f, ['"usage"'], (l) => got.push(JSON.parse(l).usage ?? JSON.parse(l).i));
  assert.deepEqual(got, [1, 2, 3, 4]);
  assert.equal(off, Buffer.byteLength(rows.join('\n') + '\n'));
});
