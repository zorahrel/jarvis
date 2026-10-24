import '../test-support/isolate-tmp.mjs';
// La quota per sessione dentro l'hub: dagli agenti (scanLiveAgents) a /api/live, con il report e i pesi dell'hub,
// e il costo di un giro di workflow (/api/automations/run) con weekShare. Senza questi due collegamenti la quota
// poteva sparire o moltiplicarsi senza che nessun test cadesse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { makeDemoRoot } from '../src/demo.mjs';
import { demoOverview } from '../src/demo-live.mjs';
import { shareFromReport } from '../src/session-use.mjs';
import { weighUsage, DEFAULT_WEIGHTS } from '../src/usage.mjs';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('/api/live: ogni sessione ha la quota che dice il report, coi pesi dell\'hub; /api/automations/run usa weekShare', { timeout: 60000 }, async () => {
  const root = makeDemoRoot(), now = Date.now(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  // una sessione viva di Claude in billing-api: il suo transcript sta nel root dei progetti
  const dir = path.join(root, '-work-billing-api'), file = path.join(dir, 'viva.jsonl');
  const u = { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(now - 60000).toISOString(), cwd: '/work/billing-api', message: { id: 'v1', usage: u } }) + '\n');
  // un giro di workflow con un agente
  const proj = path.join(tmp, 'projects'), sess = path.join(proj, '-w', 's1');
  fs.mkdirSync(path.join(sess, 'workflows'), { recursive: true }); fs.writeFileSync(path.join(sess, 'workflows', 'wf_abc.json'), '{}');
  fs.mkdirSync(path.join(sess, 'subagents', 'workflows', 'wf_abc'), { recursive: true });
  fs.writeFileSync(path.join(sess, 'subagents', 'workflows', 'wf_abc', 'agent-1.jsonl'), JSON.stringify({ message: { id: 'w1', usage: u } }) + '\n');
  const agents = [{ project: 'billing-api', provider: 'claude', model: 'Sonnet', kind: 'sessione', title: 'viva', file, cwd: '/work/billing-api', startedAt: now - 60000, lastActivity: now }];
  const srv = createServer({ root, vdm: false, free: false, openclaw: null, groups: [], alerts: { rules: [] }, quotaSource: { url: 'http://127.0.0.1:9/api/overview' }, tray: { url: 'http://127.0.0.1:9' } }, {
    inProcess: false, noLive: true, noQueue: true, overview: async () => demoOverview(now), projectsDir: proj,
    museRoot: path.join(tmp, 'muse'), codexRoot: path.join(tmp, 'codex'), diaryDir: path.join(tmp, 'diario'),
    scanAgents: () => ({ agents: agents.map((a) => ({ ...a })), lastSeen: {} }) });
  const port = await listen(srv);
  try {
    const report = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    assert.ok(report.account, 'report: ' + JSON.stringify(report).slice(0, 300));
    const live = await (await fetch(`http://127.0.0.1:${port}/api/live`)).json();
    const s = live.projects.flatMap((p) => p.agents?.list || []).find((a) => a.title === 'viva');
    assert.ok(s && s.use, 'la sessione ha il consumo: ' + JSON.stringify(live.projects.map((p) => [p.name, (p.agents?.list || []).map((a) => [a.title, a.file, a.use])])).slice(0, 600));
    const exp = shareFromReport(report, 'claude', weighUsage(u, DEFAULT_WEIGHTS));
    assert.ok(exp > 0, `quota attesa ${exp}`);
    assert.equal(s.use.pct, Number(exp.toPrecision(3)));
    const run = await (await fetch(`http://127.0.0.1:${port}/api/automations/run/wf_abc`)).json();
    assert.equal(run.weighted, Math.round(weighUsage(u)));
    assert.equal(run.weekPct, Math.round(shareFromReport(report, 'claude', weighUsage(u)) * 100) / 100);
  } finally { srv.close(); }
});
