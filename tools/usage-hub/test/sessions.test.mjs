import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newState, scanToday } from '../src/sessions.mjs';

// mezzogiorno locale: con Date.now() la riga "un'ora fa" cade su ieri fra 00:00 e 01:00
const NOW = new Date().setHours(12, 0, 0, 0);
const line = (ts, out, cache = 0, cwd = '/x/proj') => JSON.stringify({ timestamp: new Date(ts).toISOString(), cwd, message: { usage: { output_tokens: out, cache_read_input_tokens: cache, input_tokens: 999999 } } });

test('somma cache+output di oggi per sessione, ignora ieri, legge solo i byte nuovi', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  fs.mkdirSync(path.join(dir, 'p'));
  const a = path.join(dir, 'p', 'aaaaaaaa-1.jsonl');
  fs.writeFileSync(a, [line(NOW - 3600000, 10, 100), line(NOW - 3 * 86400000, 5000), line(NOW, 5, 0)].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'p', 'bbbbbbbb-2.jsonl'), line(NOW, 1, 0, '/y/altro') + '\n');
  const st = newState();
  let r = await scanToday(st, { dir, now: NOW });
  assert.deepEqual(r[0], { project: 'proj', sessions: 1, tokens: 115 }); // input_tokens non conta
  assert.equal(r[1].tokens, 1);
  fs.appendFileSync(a, line(NOW, 1000) + '\n');
  r = await scanToday(st, { dir, now: NOW });
  assert.equal(r[0].tokens, 1115); // non ricontato dall'inizio
});

test('più sessioni dello stesso progetto si sommano', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  fs.mkdirSync(path.join(dir, 'p'));
  for (const n of ['a', 'b']) fs.writeFileSync(path.join(dir, 'p', `${n}.jsonl`), line(NOW, 10) + '\n');
  const r = await scanToday(newState(), { dir, now: NOW });
  assert.deepEqual(r, [{ project: 'proj', sessions: 2, tokens: 20 }]);
});

test('a blocchi piccoli il conto è lo stesso: righe spezzate tra due blocchi e riga a metà scrittura', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  fs.mkdirSync(path.join(dir, 'p'));
  const a = path.join(dir, 'p', 'cccccccc-3.jsonl');
  const lines = Array.from({ length: 40 }, (_, i) => line(NOW, i + 1, 10));
  fs.writeFileSync(a, lines.join('\n') + '\n' + line(NOW, 7777).slice(0, 30)); // ultima riga non finita
  const st = newState();
  const r = await scanToday(st, { dir, now: NOW, chunk: 97 });
  assert.equal(r[0].tokens, 820 + 400); // 1+…+40 di output + 40×10 di cache, la riga a metà non conta
  const full = await scanToday(newState(), { dir, now: NOW });
  assert.equal(full[0].tokens, r[0].tokens);
});
