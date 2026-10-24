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

test('serve --demo con l\'HOME vero: nessun account, cartella o nome utente di questo Mac nelle API', { timeout: 120000 }, async () => {
  const port = await freePort();
  const p = spawn(process.execPath, ['bin/usage-hub.mjs', 'serve', '--demo', '--port', String(port)], { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, USAGE_HUB_ATTESA: '', USAGE_HUB_DIARIO: '', USAGE_HUB_FEEDBACK_DIR: '' } });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { try { await fetch(url + '/api/hub-config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const user = os.userInfo().username, home = os.homedir();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // anche ogni valore di config.local (numero e link WhatsApp di Jarvis, operatore…): in demo non esce nessuno
    const leaves = (o) => (o && typeof o === 'object' ? Object.values(o).flatMap(leaves) : typeof o === 'string' && o.length >= 6 ? [o] : []);
    const real = new RegExp([user, home, '.openclaw', '/jarvis', ...leaves(localConfig())].map(esc).join('|'), 'i');
    for (const u of ['/api/hub-config', '/api/automations', '/api/overview', '/api/live', '/api/pace', '/api/gates', '/api/mac', '/api/contesto', '/api/diario?days=7', '/api/attesa', '/api/services', '/api/projects', '/api/heavy', '/api/machines', '/api/pc', '/vdm/api/profiles', '/vdm/api/settings']) {
      const body = await (await fetch(url + u, { signal: AbortSignal.timeout(60000) })).text();
      const m = body.match(real);
      assert.equal(m, null, `${u} contiene «${m && body.slice(Math.max(0, m.index - 40), m.index + 40)}»`);
    }
    const hc = await (await fetch(url + '/api/hub-config')).json();
    assert.equal(hc.demo, true);
    // i bottoni «Scrivi a Jarvis» della demo: link d'esempio, nessun numero di telefono
    for (const v of Object.values(hc.jarvis)) { assert.match(String(v), /^https:\/\/esempio\.it\//); assert.doesNotMatch(String(v), /\d{7,}|wa\.me|discord\.(com|gg)/); }
  } finally { await stop(p); }
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
