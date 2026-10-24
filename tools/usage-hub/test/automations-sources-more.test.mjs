import '../test-support/isolate-tmp.mjs';
// Solo fixture in test/fixtures/automations/ e cartelle temporanee: nessun dato vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDesktop } from '../src/automations/sources/claude-desktop.mjs';
import { readWorkflows } from '../src/automations/sources/workflows.mjs';
import { createGithubSource } from '../src/automations/sources/github.mjs';
import { createPcSource } from '../src/automations/sources/pc.mjs';
import { readCounted, countTopicsSchedules } from '../src/automations/sources/counted.mjs';

const FIX = 'test/fixtures/automations';

test('desktop: dedup, neverRan, prompt senza frontmatter', () => {
  const { ok, items } = readDesktop({ bases: [path.join(FIX, 'desktop')], skillsDir: path.join(FIX, 'scheduled-tasks') });
  assert.equal(ok, true);
  assert.equal(items.length, 2); // rientro deduplicato da 2 file, vuoto.json ignorato
  const byId = Object.fromEntries(items.map((i) => [i.tech.label, i]));
  assert.equal(byId['rientro-esempio'].key, 'desktop:rientro-esempio');
  assert.equal(byId['rientro-esempio'].neverRan, true);
  assert.equal(byId['rientro-esempio'].enabled, true);
  assert.ok(Date.parse('2026-09-23T10:00:19.239Z') === byId['analisi-esempio'].last.at);
  assert.match(byId['rientro-esempio'].tech.prompt, /Controlla la quota di prova/);
  assert.doesNotMatch(byId['rientro-esempio'].tech.prompt, /description:/);
});

test('workflows: giri, fasi, cancello lobster, finestra giorni', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const projectsDir = path.join(tmp, 'projects');
  fs.cpSync(path.join(FIX, 'projects'), projectsDir, { recursive: true });
  const now = Date.now();
  const day = 86400000;
  const files = [
    path.join(projectsDir, '-work-demo/abc/workflows/wf_00000001-aaa.json'),
    path.join(projectsDir, '-work-demo/abc/workflows/wf_00000002-bbb.json'),
  ];
  for (const f of files) fs.utimesSync(f, new Date(now - day), new Date(now - day));
  const args = {
    projectsDir,
    lobsterRuns: path.join(FIX, 'lobster-runs/runs.jsonl'),
    lobsterState: path.join(FIX, 'lobster/state'),
    now,
  };
  const r = readWorkflows(args);
  assert.equal(r.ok, true);
  const wf = r.items.find((i) => i.key === 'workflow:revisione-prova');
  assert.ok(wf);
  assert.equal(wf.runs.length, 2);
  assert.equal(wf.last.outcome, 'error');
  const failed = r.runs.find((x) => x.runId === 'wf_00000002-bbb');
  assert.deepEqual(failed.phases, [
    { title: 'Leggi', total: 1, done: 1, failed: 0 },
    { title: 'Verifica', total: 1, done: 0, failed: 1 },
  ]);
  const lob = r.items.find((i) => i.key === 'lobster:prova');
  assert.ok(lob);
  assert.equal(lob.waitingApproval.step, 'cancello');
  for (const f of files) fs.utimesSync(f, new Date(now - 8 * day), new Date(now - 8 * day));
  const old = readWorkflows(args);
  assert.equal(old.items.some((i) => i.key === 'workflow:revisione-prova'), false);
});

test('github: pending, mediana schedule, un target in errore', async () => {
  const T = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const ghRuns = [
    { conclusion: 'failure', createdAt: iso(T), event: 'schedule', status: 'completed', url: 'https://gh/r5' },
    { conclusion: 'success', createdAt: iso(T - 86400000), event: 'schedule', status: 'completed', url: 'https://gh/r4' },
    { conclusion: 'success', createdAt: iso(T - 2 * 86400000), event: 'schedule', status: 'completed', url: 'https://gh/r3' },
    { conclusion: 'success', createdAt: iso(T - 3 * 86400000), event: 'push', status: 'completed', url: 'https://gh/r2' },
    { conclusion: 'success', createdAt: iso(T - 4 * 86400000), event: 'push', status: 'completed', url: 'https://gh/r1' },
  ];
  const src = createGithubSource({ targets: [{ key: 'gh:acme/web/notte.yml' }], run: async () => ghRuns });
  assert.equal(src.read().pending, true);
  const r = await src.refresh();
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].last.outcome, 'error');
  assert.equal(r.items[0].everyMs, 86400000);
  assert.equal(r.items[0].nextApprox, true);
  const run2 = async (args) => {
    if (args[args.indexOf('--workflow') + 1] === 'ko.yml') throw new Error('403');
    return ghRuns;
  };
  const src2 = createGithubSource({ targets: [{ key: 'gh:o/r/ok.yml' }, { key: 'gh:o/r/ko.yml' }], run: run2 });
  const r2 = await src2.refresh();
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.items.map((i) => i.key), ['gh:o/r/ok.yml']);
});

test('pc: dorme senza query, sveglio con un solo wf-', async () => {
  let called = false;
  const asleep = createPcSource({ pcState: async () => ({ pc: 'dorme' }), query: async () => { called = true; return ''; } });
  assert.equal(asleep.read().pending, true);
  const s = await asleep.refresh();
  assert.equal(called, false);
  assert.equal(s.asleep, true);
  assert.deepEqual(s.items, []);
  const csv = [
    '"HostName","TaskName","Next Run Time","Status","Last Run Time","Last Result","Schedule Type","Start Time","Task To Run"',
    '"PC","\\wf-prova","23/10/2026 02:00:00","Ready","22/10/2026 02:00:00","0","Daily","2:00:00 AM","C:\\x.bat"',
    '"PC","\\Microsoft\\Altro","23/10/2026 03:00:00","Ready","22/10/2026 03:00:00","0","Daily","3:00:00 AM","C:\\y.bat"',
  ].join('\r\n');
  const awake = createPcSource({ pcState: async () => ({ pc: 'acceso' }), query: async () => csv });
  const w = await awake.refresh();
  assert.equal(w.items.length, 1);
  assert.equal(w.items[0].key, 'pc:wf-prova');
  assert.equal(w.items[0].last.outcome, 'ok');
});

test('counted: codex, jcode, topics noto o ignoto', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnt-'));
  const codexDir = path.join(tmp, 'codex');
  fs.mkdirSync(codexDir);
  fs.writeFileSync(path.join(codexDir, 'a.json'), '{}');
  fs.writeFileSync(path.join(codexDir, 'b.json'), '{}');
  const queue = path.join(tmp, 'queue.json');
  fs.writeFileSync(queue, JSON.stringify([{}, {}, {}]));
  const r = await readCounted({ codexDir, jcodeQueue: queue, topics: async () => 0 });
  assert.deepEqual(r.counts, { codex: 2, jcode: 3, topics: 0 });
  const r2 = await readCounted({ codexDir, jcodeQueue: queue, topics: async () => { throw new Error('giù'); } });
  assert.equal(r2.counts.topics, null);
});

test('counted: topics legge le rotte che Topics ha davvero e conta solo le ricorrenze accese', async () => {
  // Forme vere misurate il 24/10: /api/all-boards/projects → {projects:[{projectId}]},
  // /api/boards/:id/scheduled-cards → {schedules:[{enabled}]}. /api/boards non esiste (404).
  const asked = [];
  const routes = {
    '/api/all-boards/projects': { projects: [{ projectId: 'a', name: 'A' }, { projectId: 'b c', name: 'B' }] },
    '/api/boards/a/scheduled-cards': { schedules: [{ id: 1, enabled: true }, { id: 2, enabled: false }] },
    '/api/boards/b%20c/scheduled-cards': { schedules: [{ id: 3, enabled: true }] },
  };
  const fetchJson = async (p) => {
    asked.push(p);
    if (!(p in routes)) throw new Error('http 404');
    return routes[p];
  };
  assert.equal(await countTopicsSchedules(fetchJson), 2);
  assert.ok(!asked.includes('/api/boards'), 'chiede /api/boards, che in Topics non esiste');
});
