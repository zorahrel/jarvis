// Pulsanti che scrivono nella dashboard: (1) ognuno chiama l'endpoint giusto col payload giusto (fetch finto, nessun account toccato);
// (2) priorità e tetto di un account vero: POST, rilettura, ripristino del valore di prima (solo se il proxy VDM è raggiungibile).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// actions.js gira anche nel browser: qui lo si esegue in un contesto isolato, senza moduli.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'public/actions.js'), 'utf8'), ctx);
const actionRequest = (...a) => JSON.parse(JSON.stringify(ctx.actionRequest(...a)));
const vdmSrc = fs.readFileSync(path.join(root, 'modules/vdm/dashboard.mjs'), 'utf8');

// Fetch finto: registra cosa partirebbe verso /vdm.
const sent = [];
const fakeFetch = async (path_, { method = 'POST', body } = {}) => { sent.push({ path: path_, method, body: JSON.parse(body) }); return { ok: true }; };
const click = async (act, d, ctx) => { const r = actionRequest(act, d, ctx); await fakeFetch(r.path, { method: r.method, body: JSON.stringify(r.body) }); return sent.at(-1); };

test('ogni pulsante chiama l\'endpoint giusto col payload giusto', async () => {
  assert.deepEqual(await click('prio', { n: 'auto-3', v: '2' }), { path: '/api/priority', method: 'POST', body: { name: 'auto-3', priority: 2 } });
  assert.deepEqual(await click('switch', { n: 'auto-3' }), { path: '/api/switch', method: 'POST', body: { name: 'auto-3' } });
  assert.deepEqual(await click('remove', { n: 'auto-3' }), { path: '/api/remove', method: 'POST', body: { name: 'auto-3' } });
  assert.deepEqual(await click('refresh', { n: 'auto-3' }), { path: '/api/refresh', method: 'POST', body: { name: 'auto-3' } });
  assert.deepEqual(await click('enabled', { n: 'auto-3' }, { checked: false }), { path: '/api/account-enabled', method: 'POST', body: { name: 'auto-3', enabled: false } });
  assert.deepEqual(await click('cap', { n: 'auto-3', own: '0' }), { path: '/api/account-cap', method: 'POST', body: { name: 'auto-3', fiveH: 75, sevenD: 75 } });
  assert.deepEqual(await click('cap', { n: 'auto-3', own: '1' }), { path: '/api/account-cap', method: 'POST', body: { name: 'auto-3', fiveH: null, sevenD: null } });
  assert.deepEqual(await click('capv', { n: 'auto-3', w: 'sevenD' }, { value: '60' }), { path: '/api/account-cap', method: 'POST', body: { name: 'auto-3', sevenD: 60 } });
  assert.deepEqual(await click('capv', { n: 'auto-3', w: 'fiveH' }, { value: '' }), { path: '/api/account-cap', method: 'POST', body: { name: 'auto-3', fiveH: null } });
  assert.deepEqual(await click('apiprio', { n: 'account-a' }, { apiPriority: '20' }), { path: '/api/api-profiles', method: 'PATCH', body: { name: 'account-a', priority: 20 } });
  assert.deepEqual(await click('apidis', { n: 'account-a', v: '1' }), { path: '/api/api-profiles', method: 'PATCH', body: { name: 'account-a', disabled: true } });
});

test('tetto fuori da 1-99 non parte', () => {
  assert.match(actionRequest('capv', { n: 'a', w: 'fiveH' }, { value: '150' }).error, /1 a 99/);
  assert.match(actionRequest('capv', { n: 'a', w: 'fiveH' }, { value: '0' }).error, /1 a 99/);
});

test('gli endpoint usati esistono davvero nel proxy VDM, con quel metodo', () => {
  for (const s of sent) assert.ok(new RegExp(`pathname === '${s.path}' && req\\.method === '${s.method}'`).test(vdmSrc), `${s.method} ${s.path} non esiste in VDM`);
});

// ---- prova viva e reversibile ----
const VDM_PORT = 3335;
const vdmUp = await new Promise((r) => http.get({ host: '127.0.0.1', port: VDM_PORT, path: '/api/settings', timeout: 1500 }, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)).on('timeout', function () { this.destroy(); r(false); }));

test('priorità e tetto di un account: scrivo, rileggo, ripristino', { skip: vdmUp ? false : 'proxy VDM non raggiungibile' }, async () => {
  const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] }, vdm: { port: VDM_PORT } }, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }), root });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/vdm`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const prof = async () => (await (await fetch(base + '/api/profiles')).json()).profiles;
  const before = (await prof()).find((p) => !p.isActive) || (await prof())[0];
  const name = before.name, ov = before.cap.override || {};
  try {
    const want = (before.priority || 0) + 7;
    const r = await post('/api/priority', { name, priority: want });
    assert.notEqual(r.ok, false);
    assert.equal((await prof()).find((p) => p.name === name).priority, want, 'la priorità riletta non è quella scritta');
    const r2 = await post('/api/account-cap', { name, fiveH: 63, sevenD: 64 });
    assert.notEqual(r2.ok, false);
    const c = (await prof()).find((p) => p.name === name).cap.override;
    assert.deepEqual([c.fiveH, c.sevenD], [63, 64], 'il tetto riletto non è quello scritto');
  } finally {
    await post('/api/priority', { name, priority: before.priority || 0 });
    await post('/api/account-cap', { name, fiveH: ov.fiveH ?? null, sevenD: ov.sevenD ?? null });
  }
  const after = (await prof()).find((p) => p.name === name);
  assert.equal(after.priority, before.priority || 0, 'priorità non ripristinata');
  assert.deepEqual([after.cap.override.fiveH, after.cap.override.sevenD], [ov.fiveH ?? null, ov.sevenD ?? null], 'tetto non ripristinato');
  srv.close();
});
