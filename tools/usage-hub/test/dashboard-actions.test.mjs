import '../test-support/isolate-tmp.mjs';
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

// ---- priorità e tetto contro un proxy VDM finto ----
// Mai sul proxy vero (:3335): il giro 8 ci scriveva a ogni suite e la pagina Attività vera si riempiva di
// «priority-set» e «account-cap» di prova. Qui un server locale su porta 0 fa la parte del proxy.
function fakeVdm() {
  const profiles = [{ name: 'prova-a', isActive: true, priority: 2, cap: { override: {} } }, { name: 'prova-b', isActive: false, priority: 1, cap: { override: {} } }];
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; }).on('end', () => {
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const b = body ? JSON.parse(body) : {}, p = profiles.find((x) => x.name === b.name);
      calls.push(req.method + ' ' + req.url);
      if (req.url === '/api/profiles' && req.method === 'GET') return send({ profiles });
      if (req.url === '/api/priority' && req.method === 'POST' && p) { p.priority = b.priority; return send({ ok: true }); }
      if (req.url === '/api/account-cap' && req.method === 'POST' && p) { for (const k of ['fiveH', 'sevenD']) if (k in b) p.cap.override[k] = b[k]; return send({ ok: true }); }
      res.writeHead(404); res.end('{}');
    });
  });
  return { srv, calls, profiles };
}

test('priorità e tetto di un account passano dall\'hub al proxy e si rileggono (proxy finto)', { timeout: 20000 }, async () => {
  const vdm = fakeVdm();
  await new Promise((r) => vdm.srv.listen(0, '127.0.0.1', r));
  const srv = createServer({ quotaSource: { url: 'http://x' }, alerts: { rules: [] }, vdm: { port: vdm.srv.address().port } }, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }), root });
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}/vdm`;
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const prof = async () => (await (await fetch(base + '/api/profiles')).json()).profiles;
    assert.notEqual((await post('/api/priority', { name: 'prova-b', priority: 8 })).ok, false);
    assert.equal((await prof()).find((p) => p.name === 'prova-b').priority, 8, 'la priorità riletta non è quella scritta');
    assert.notEqual((await post('/api/account-cap', { name: 'prova-b', fiveH: 63, sevenD: 64 })).ok, false);
    const c = (await prof()).find((p) => p.name === 'prova-b').cap.override;
    assert.deepEqual([c.fiveH, c.sevenD], [63, 64], 'il tetto riletto non è quello scritto');
    assert.deepEqual(vdm.calls.filter((x) => x.startsWith('POST')), ['POST /api/priority', 'POST /api/account-cap']);
  } finally {
    srv.close(); vdm.srv.close(); srv.closeAllConnections?.(); vdm.srv.closeAllConnections?.();
  }
});
