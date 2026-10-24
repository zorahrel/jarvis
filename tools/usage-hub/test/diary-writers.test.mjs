// Chi scrive nel diario lo fa dai suoi rami veri, su fixture, mai nel diario vero:
// `usage-hub check` (runAlerts → notify → scripts/notify-diario.mjs) e quota-guard.py di OpenClaw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAlerts } from '../src/alerts.mjs';
import { journal, readDiary } from '../src/journal.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rows = (dir) => fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));

test('usage-hub check: ogni tipo di avviso va nel diario con la sua voce, nessuno sotto «Soglie per progetto» per sbaglio', async () => {
  const dir = tmp('diario-check-');
  const prev = process.env.USAGE_HUB_DIARIO; process.env.USAGE_HUB_DIARIO = dir;
  try {
    const now = Date.now(), reset = now + 3 * 86400000;
    const report = {
      at: now, account: { weekPct: 40, weekResetsAt: reset, fiveHourPct: 10 },
      projects: [{ name: 'progetto-fixture', weekPct: 5 }],
      muse: { quota: { weekPct: 90, weekResetsAt: reset }, projects: [] },
      pace: [{ provider: 'codex', account: 'cx-fixture', status: 'esaurito', used: 100, resetsAt: reset }],
    };
    const config = { alerts: { rules: [{ scope: 'project', project: 'progetto-fixture', threshold: 3 }, { scope: 'account', metric: '7d', threshold: 30 }],
      notify: { command: 'node scripts/notify-diario.mjs' } } };
    const fired = await runAlerts(report, config);
    assert.equal(fired.length, 4);
    const got = Object.fromEntries(rows(dir).map((r) => [r.source, r]));
    assert.deepEqual(Object.keys(got).sort(), ['abbonamenti', 'ritmo-muse', 'soglia-account', 'soglia-progetto']);
    assert.match(got['soglia-progetto'].text, /progetto-fixture/);
    assert.match(got.abbonamenti.text, /esaurito/);
    const titles = journal({ diary: readDiary({ dir }), now: now + 1000 }).map((e) => e.who).sort();
    assert.deepEqual(titles, ['Abbonamenti', 'Ritmo Muse', 'Soglie degli abbonamenti', 'Soglie per progetto']);
  } finally { if (prev == null) delete process.env.USAGE_HUB_DIARIO; else process.env.USAGE_HUB_DIARIO = prev; }
});

// Su questo Mac (c'è ~/.openclaw) il guardiano deve esserci: se manca il test cade, non si salta in silenzio.
// Si salta solo su una macchina senza OpenClaw, e lo dice. QUOTA_GUARD_PY sposta il percorso (mutazioni, prove).
const QG = process.env.QUOTA_GUARD_PY || path.join(os.homedir(), '.openclaw', 'bin', 'quota-guard.py');
const NO_OPENCLAW = !process.env.QUOTA_GUARD_PY && !fs.existsSync(path.join(os.homedir(), '.openclaw'));
test('quota-guard.py vero su fixture: oltre il budget scrive una riga nel diario di prova', { skip: NO_OPENCLAW && 'macchina senza OpenClaw: quota-guard non provato' }, async () => {
  assert.ok(fs.existsSync(QG), `quota-guard.py assente in ${QG}: il diario degli avvisi di soglia non ha chi lo scrive`);
  const dir = tmp('diario-qg-'), work = tmp('qg-');
  const now = Date.now(), resetS = Math.floor(now / 1000) + 3 * 86400;
  const overview = { providers: [
    { id: 'claude', accounts: [{ active: true, quotas: [{ key: '7d', usedPct: 40, resetsAt: resetS }] }] },
    { id: 'muse', accounts: [{ active: true, quotas: [{ key: '7d', usedPct: 10, resetsAt: resetS }] }] }] };
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(overview)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    // PoP pesa metà dei token della settimana: 50% di 40% = 20%, oltre il budget del 3%
    const line = JSON.stringify({ timestamp: new Date(now - 3600000).toISOString(), message: { usage: { input_tokens: 1000, output_tokens: 0 } } });
    for (const d of ['-Users-zorahrel--openclaw-workspace-pop-demo', '-altro-progetto']) {
      fs.mkdirSync(path.join(work, 'projects', d), { recursive: true }); fs.writeFileSync(path.join(work, 'projects', d, 's.jsonl'), line + '\n');
    }
    // asincrono: con spawnSync il server della fixture, nello stesso processo, non risponderebbe
    const run = (env) => new Promise((resolve) => { const c = spawn('python3', [QG], { env }); let stdout = '', stderr = '';
      c.stdout.on('data', (b) => { stdout += b; }); c.stderr.on('data', (b) => { stderr += b; }); c.on('close', (status) => resolve({ status, stdout, stderr })); });
    const r = await run({ ...process.env, DIARIO_DIR: dir,
      QUOTA_GUARD_OVERVIEW: `http://127.0.0.1:${srv.address().port}/api/overview`, QUOTA_GUARD_PROJECTS: path.join(work, 'projects'),
      QUOTA_GUARD_STATE: path.join(work, 'state.json'), QUOTA_GUARD_BUDGETS: path.join(work, 'nessuno.json'), QUOTA_GUARD_TMUX: '/usr/bin/true' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'quota-guard non deve stampare: lo stdout va su WhatsApp');
    const got = rows(dir);
    assert.equal(got.length, 1);
    assert.equal(got[0].source, 'quota-guard'); assert.equal(got[0].kind, 'budget');
    assert.match(got[0].text, /PrinceOfPersia è al 20\.0%/);
  } finally { srv.close(); }
});
