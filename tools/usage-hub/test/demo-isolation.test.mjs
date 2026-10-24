import '../test-support/isolate-tmp.mjs';
// La demo è tutta di prova: nessun giro vivo (avvisi, gateway, pausa dei processi) e niente dati di questo Mac nelle risposte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { liveJobs } from '../src/server.mjs';
import { localConfig } from '../src/local-config.mjs';
import { sweepStaleDemoRoots } from '../src/demo.mjs';
import { snapshotReal, realChanges, realStrings, phoneLike } from '../test-support/real-data.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('liveJobs: solo l\'hub vero fa giri vivi, mai test, --no-live o --demo', () => {
  assert.equal(liveJobs({}), true);
  assert.equal(liveJobs({ demo: true }), false);
  assert.equal(liveJobs({ noLive: true }), false);
  assert.equal(liveJobs({ inProcess: true }), false);
});

// SIGTERM (la demo toglie la sua cartella), e SIGKILL se dopo 5 s è ancora lì: un test non resta mai appeso
const stop = (p) => new Promise((r) => { if (p.exitCode != null) return r(); const t = setTimeout(() => p.kill('SIGKILL'), 5000); p.on('exit', () => { clearTimeout(t); r(); }); p.kill('SIGTERM'); });
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// tutte le API che la pagina della demo legge (anche quelle del proxy VDM, finte in demo)
const DEMO_APIS = ['/api/hub-config', '/api/automations', '/api/overview', '/api/live', '/api/pace', '/api/gates', '/api/mac', '/api/contesto', '/api/diario?days=7', '/api/attesa', '/api/services', '/api/projects', '/api/heavy', '/api/machines', '/api/pc', '/api/queue', '/api/alerts',
  '/vdm/api/profiles', '/vdm/api/settings', '/vdm/api/sessions', '/vdm/api/token-usage?days=7', '/vdm/api/activity',
  '/api/feedback', '/api/feedback?open=1', '/api/automations/summary', '/api/forecast', '/api/contesto/check'];
// più lo schema del pannello di ogni automazione (/api/automations/graph?key=…), che la pagina chiede a ogni apertura

test('serve --demo con l\'HOME vero: nessun account, cartella o nome utente di questo Mac nelle API', { timeout: 120000 }, async () => {
  const port = await freePort(), before = snapshotReal();
  const p = spawn(process.execPath, ['bin/usage-hub.mjs', 'serve', '--demo', '--port', String(port)], { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, USAGE_HUB_ATTESA: '', USAGE_HUB_DIARIO: '', USAGE_HUB_FEEDBACK_DIR: '' } });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { try { await fetch(url + '/api/hub-config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const user = os.userInfo().username, home = os.homedir();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // anche ogni valore di config.local (numero e link WhatsApp di Jarvis, operatore…): in demo non esce nessuno
    const leaves = (o) => (o && typeof o === 'object' ? Object.values(o).flatMap(leaves) : typeof o === 'string' && o.length >= 6 ? [o] : []);
    // e i testi veri di diario e «Ti aspetta» e il numero di notify.json: la demo non legge niente di vero
    const real = new RegExp([user, home, '.openclaw', '/jarvis', ...leaves(localConfig()), ...realStrings()].map(esc).join('|'), 'i');
    const auto = await (await fetch(url + '/api/automations')).json();
    const keys = Object.keys(auto.cards || {}).length ? Object.keys(auto.cards) : (auto.items || auto.rows || []).map((c) => c.key).filter(Boolean);
    assert.ok(keys.length >= 3, 'la demo ha automazioni da aprire');
    const realDigits = realStrings().filter((x) => /^\d{9,}$/.test(x));
    for (const u of [...DEMO_APIS, ...keys.map((k) => '/api/automations/graph?key=' + encodeURIComponent(k))]) {
      const body = await (await fetch(url + u, { signal: AbortSignal.timeout(60000) })).text();
      const m = body.match(real);
      // le cifre dei numeri veri in qualunque forma: tolto tutto ciò che non è cifra, la sentinella non deve comparire
      // nella risposta intera (giro 9: lineetta lunga, numero dopo una data e numero JSON con chiave «telefono» passavano)
      const dd = body.replace(/\D/g, ''), hit = realDigits.find((x) => dd.includes(x));
      assert.equal(hit, undefined, `${u} contiene un numero vero (${hit && hit.slice(0, 3)}…)`);
      assert.equal(m, null, `${u} contiene «${m && body.slice(Math.max(0, m.index - 40), m.index + 40)}»`);
      // nessuna email fuori dai domini d'esempio: l'email vera dell'account non ha la forma della sentinella
      const mails = [...body.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((x) => x[0]).filter((x) => !/@(?:esempio\.it|example\.(?:com|org)|s\.whatsapp\.net)$/i.test(x));
      assert.deepEqual(mails, [], `${u} ha email fuori dai domini d'esempio`);
      // nessun numero di telefono in nessuna forma (+39…, 39…@s.whatsapp.net, wa.me/…)
      let j = null; try { j = JSON.parse(body); } catch { /* non JSON */ }
      if (j) assert.deepEqual(phoneLike(j), [], `${u} ha un numero di telefono`);
    }
    const hc = await (await fetch(url + '/api/hub-config')).json();
    assert.equal(hc.demo, true);
    // i bottoni «Scrivi a Jarvis» della demo: link d'esempio, nessun numero di telefono
    for (const v of Object.values(hc.jarvis)) { assert.match(String(v), /^https:\/\/esempio\.it\//); assert.doesNotMatch(String(v), /\d{7,}|wa\.me|discord\.(com|gg)/); }
  } finally { await stop(p); }
  // la demo non scrive nei file veri (diario, «Ti aspetta», feedback): nella barra HOME è finta e si confronta tutto
  assert.deepEqual(realChanges(before), []);
});

test('serve --demo fermato con SIGTERM toglie la sua cartella; una rimasta da un SIGKILL si toglie alla partenza dopo', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tmp-')), port = await freePort();
  const stale = path.join(tmp, 'usage-hub-demo-vecchia'); fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, '.pid'), '999999');
  const old = (Date.now() - 2 * 3600000) / 1000; fs.utimesSync(stale, old, old);
  const keep = path.join(tmp, 'usage-hub-demo-viva'); fs.mkdirSync(keep); fs.writeFileSync(path.join(keep, '.pid'), String(process.pid)); fs.utimesSync(keep, old, old);
  const p = spawn(process.execPath, ['bin/usage-hub.mjs', 'serve', '--demo', '--no-live', '--port', String(port)], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TMPDIR: tmp } });
  const exited = new Promise((r) => p.on('exit', r));
  try {
  for (let i = 0; i < 150; i++) { try { await fetch(`http://127.0.0.1:${port}/api/hub-config`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const mine = fs.readdirSync(tmp).filter((n) => n.startsWith('usage-hub-demo-') && !['usage-hub-demo-viva'].includes(n));
  assert.equal(mine.length, 1, `solo la cartella della demo accesa: ${mine}`); // la vecchia di un processo morto è sparita
  assert.ok(fs.existsSync(keep), 'la cartella di una demo ancora accesa resta');
  p.kill('SIGTERM');
  assert.ok(await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]), 'la demo non esce con SIGTERM');
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('usage-hub-demo-')), ['usage-hub-demo-viva']);
  assert.equal(sweepStaleDemoRoots(tmp), 0);
  } finally { p.kill('SIGKILL'); }
});

test('sweepStaleDemoRoots: anche le demo annidate e le cartelle di prova vecchie, mai quelle di un processo vivo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')), old = Date.now() - 7 * 3600000;
  const mk = (rel, pid) => { const p = path.join(tmp, rel); fs.mkdirSync(p, { recursive: true }); if (pid != null) fs.writeFileSync(path.join(p, '.pid'), String(pid)); return p; };
  const age = (p) => fs.utimesSync(p, old / 1000, old / 1000);
  // demo morta dentro una cartella di prova: va tolta, e con lei la cartella vuota
  const nested = mk('demo-tmp-abc/usage-hub-demo-vecchia', 999999); age(nested); age(path.join(tmp, 'demo-tmp-abc'));
  // cartelle di prova vecchie senza processi vivi
  for (const d of ['ui-bar-xyz/home', 'ux-proofs-q1/home']) { const p = mk(d); age(p); age(path.dirname(p)); }
  // demo viva annidata (pid di questo processo): resta, con la sua cartella
  const live = mk('demo-tmp-viva/usage-hub-demo-viva', process.pid); age(live); age(path.join(tmp, 'demo-tmp-viva'));
  // cartella di prova recente: resta
  mk('ui-bar-recente/home');
  // giro 9: demo morte annidate a più livelli in cartelle qualsiasi (hub-test-*, tmp* di Python): vanno tolte, e la
  // cartella che le conteneva sparisce solo se resta vuota
  for (const d of ['hub-test-AbC/usage-hub-demo-1', 'hub-test-AbC/usage-hub-demo-2', 'tmpq1w2e3/a/b/usage-hub-demo-3']) age(mk(d, 999999));
  age(path.join(tmp, 'hub-test-AbC'));
  const other = mk('tmpaltrui/dati'); fs.writeFileSync(path.join(other, 'x'), 'non nostro'); age(other); age(path.dirname(other));
  const mixed = mk('tmpmisto/usage-hub-demo-4', 999999); age(mixed); fs.writeFileSync(path.join(tmp, 'tmpmisto', 'altro.txt'), 'x'); age(path.join(tmp, 'tmpmisto'));
  // demo viva sepolta a tre livelli: resta, e con lei tutta la catena
  const deepLive = mk('tmpvivo/x/y/usage-hub-demo-viva', process.pid); age(deepLive);
  // demo con .pid morto ma un file appena scritto dentro: non è vecchia, resta
  const fresh = mk('tmpfresco/usage-hub-demo-5', 999999); fs.mkdirSync(path.join(fresh, 'log')); age(fresh);   // vecchia lei, recente solo log/
  const n = sweepStaleDemoRoots(tmp);
  const left = fs.readdirSync(tmp).sort();
  assert.deepEqual(left, ['demo-tmp-viva', 'tmpaltrui', 'tmpfresco', 'tmpmisto', 'tmpvivo', 'ui-bar-recente'], 'rimaste: ' + left);
  assert.ok(fs.existsSync(live));
  assert.ok(fs.existsSync(deepLive), 'demo viva annidata a più livelli');
  assert.ok(fs.existsSync(path.join(other, 'x')), 'cartella non nostra intatta');
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'tmpmisto')), ['altro.txt'], 'la demo morta va, il file altrui resta');
  assert.ok(fs.existsSync(fresh), 'demo con contenuto recente');
  assert.equal(n, 7);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('phoneLike: ogni forma di numero di telefono, nessuna misura', () => {
  // giro 9: lineetta lunga, numero subito dopo una data e numero JSON con chiave che finisce per n/t/c/i/o passavano
  const phones = [{ x: '+39 333–000–1122' }, { x: '+39 333—000—1122' }, { x: 'chiamato il 2026-10-24 333 000 1122' }, { x: '+39 (333) 000-1122' },
    { x: '0039.333.000.1122' }, { x: 'wa.me/393330001122' }, { x: '393330001122@s.whatsapp.net' },
    { telefono: 3330001122 }, { numero: 3330001122 }, { contatto: 3330001122 }, { to: 3330001122 }, { recipient: 3330001122 }, { destination: 3330001122 }];
  for (const j of phones) assert.notDeepEqual(phoneLike(j), [], `non visto: ${JSON.stringify(j)}`);
  const measures = [{ ts: 1792918800000 }, { at: 1792918800 }, { inputTokens: 123456789 }, { n: 123456789 }, { x: '2026-10-24T09:30:00.123Z' },
    { x: '2026-10-24 09:30' }, { x: '11111111-aaaa-4000-8000-000000000001' }];
  for (const j of measures) assert.deepEqual(phoneLike(j), [], `falso positivo: ${JSON.stringify(j)}`);
});
