// La demo è tutta di prova: nessun giro vivo (avvisi, gateway, pausa dei processi) e niente dati di questo Mac nelle risposte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveJobs } from '../src/server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('liveJobs: solo l\'hub vero fa giri vivi, mai test, --no-live o --demo', () => {
  assert.equal(liveJobs({}), true);
  assert.equal(liveJobs({ demo: true }), false);
  assert.equal(liveJobs({ noLive: true }), false);
  assert.equal(liveJobs({ inProcess: true }), false);
});

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
    const real = new RegExp([user, home, '.openclaw', 'jarvis'].map(esc).join('|'), 'i');
    for (const u of ['/api/overview', '/api/live', '/api/pace', '/api/gates', '/api/mac', '/api/contesto', '/api/diario?days=7', '/api/attesa', '/api/services', '/api/projects', '/api/heavy', '/api/machines', '/api/pc']) {
      const body = await (await fetch(url + u, { signal: AbortSignal.timeout(60000) })).text();
      const m = body.match(real);
      assert.equal(m, null, `${u} contiene «${m && body.slice(Math.max(0, m.index - 40), m.index + 40)}»`);
    }
    assert.equal((await (await fetch(url + '/api/hub-config')).json()).demo, true);
  } finally { p.kill(); }
});
