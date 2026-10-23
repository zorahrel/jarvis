// Azioni del menu: lo stop dei lavori in background ferma massivo e batch ma non te, l'override vale anche per la delega,
// e nessuna pagina web può scrivere sull'hub (Origin estranea → 403).
import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-actions-'));
process.env.USAGE_HUB_OVERRIDES = path.join(dir, 'overrides.json');
const { gate, buildPace } = await import('../src/pacing.mjs');
const { addHold, activeOverrides, loadOverrides, revokeHold, addOverride } = await import('../src/overrides.mjs');
const { route } = await import('../src/route.mjs');
const { createServer } = await import('../src/server.mjs');

const NOW = Date.now(), D = 86400000;
const ov = { providers: [{ id: 'claude', accounts: [{ label: 'a', quotas: [{ key: '7d', usedPct: 60, resetsAt: (NOW + 5 * D) / 1000 }] }] }] };

test('stop dei lavori in background: ferma massivo e batch, non interattivo né gusto', () => {
  addHold({ hours: 1, by: 'test', reason: 'Mac sotto sforzo' }, { now: NOW });
  const o = activeOverrides(loadOverrides(), NOW), rows = buildPace(ov, { now: NOW });
  assert.equal(gate(rows, 'batch', { overrides: o, now: NOW }).go, false);
  assert.equal(gate(rows, 'massivo', { overrides: o, now: NOW }).hold, true);
  assert.equal(gate(rows, 'interattivo', { overrides: o, now: NOW }).go, true);
  assert.equal(gate(rows, 'gusto', { overrides: o, now: NOW }).go, true);
  revokeHold({ now: NOW });
  assert.equal(gate(rows, 'batch', { overrides: activeOverrides(loadOverrides(), NOW), now: NOW, skip: [] }).go, true);
});

test('l\'override del ritmo vale anche per la delega', async () => {
  const rows = buildPace(ov, { now: NOW }); // 60% a 2/7 della settimana: ritmo oltre il limite del gusto? no, del massivo sì
  const cls = async () => ({ cls: 'mechanical', tools: true });
  const before = await route(rows, 'x', { classify: cls });
  assert.equal(before.go, false, 'senza override il massivo è frenato su Claude');
  const o = [addOverride({ provider: 'claude', hours: 2, by: 'test', reason: 'prova' }, { now: NOW })];
  const after = await route(rows, 'x', { classify: cls, overrides: o });
  assert.equal(after.go, true);
});

test('scritture da un\'altra origine rifiutate, da curl e dalla dashboard passano', async () => {
  const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] } }, { noLive: true, overview: async () => ov });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/hold`;
  const evil = await fetch(url, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'text/plain' }, body: '{}' });
  const local = await fetch(url, { method: 'POST', body: JSON.stringify({ hours: 1, reason: 'prova' }) });
  const dash = await fetch(url, { method: 'DELETE', headers: { origin: 'http://127.0.0.1:3360' } });
  srv.close();
  assert.equal(evil.status, 403);
  assert.equal((await local.json()).hold, true);
  assert.equal((await dash.json()).removed, 1);
});
