import '../test-support/isolate-tmp.mjs';
// Fonti automazioni: OpenClaw, launchd, parità con gli originali. Solo fixture sintetiche.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { whenOf, condOf, whoOf, outOf, fp, timesOfCron, timesOfLaunchd } from '../src/automations/describe.mjs';
import { findings } from '../src/automations/health.mjs';
import { readOpenclaw } from '../src/automations/sources/openclaw.mjs';
import { readLaunchd } from '../src/automations/sources/launchd.mjs';

const NOW = 1792764000000;
const here = path.dirname(new URL(import.meta.url).pathname);
const fix = (p) => path.join(here, 'fixtures', p);

function buildOpenclawDb(file, jobRows) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cron_jobs (job_id TEXT, name TEXT, enabled INTEGER, payload_kind TEXT, job_json TEXT, state_json TEXT)');
  db.exec('CREATE TABLE cron_run_receipts (job_id TEXT, status TEXT, started_at_ms INTEGER, finished_at_ms INTEGER, error_text TEXT)');
  const insJob = db.prepare('INSERT INTO cron_jobs (job_id, name, enabled, payload_kind, job_json, state_json) VALUES (?, ?, ?, ?, ?, ?)');
  const insRec = db.prepare('INSERT INTO cron_run_receipts (job_id, status, started_at_ms, finished_at_ms, error_text) VALUES (?, ?, ?, ?, ?)');
  for (const r of jobRows) {
    insJob.run(r.job_id, r.name, r.enabled, r.payload_kind, JSON.stringify(r.job), JSON.stringify(r.state));
    for (const rec of r.receipts || []) {
      const at = NOW - rec.ago * 60000;
      insRec.run(r.job_id, rec.status, at, at + 1000, rec.error || null);
    }
  }
  db.close();
}

test('openclaw: 6 item, esclusi spento e at', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  const file = path.join(tmp, 'openclaw.sqlite');
  const { jobs } = JSON.parse(fs.readFileSync(fix('automations/openclaw-jobs.json'), 'utf8'));
  buildOpenclawDb(file, jobs);
  const res = readOpenclaw({ db: file, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.items.length, 6);
  assert.equal(res.disabled, 1);
  assert.equal(res.dated, 1);
  assert.ok(!res.items.some((i) => i.key === 'cron:11111111-aaaa-4000-8000-000000000006'), 'niente promemoria at');
  assert.ok(!res.items.some((i) => i.key === 'cron:11111111-aaaa-4000-8000-000000000007'), 'niente job spento');
});

test('openclaw: salute in errore, posta soppressa, ricevute ordinate', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  const file = path.join(tmp, 'openclaw.sqlite');
  const { jobs } = JSON.parse(fs.readFileSync(fix('automations/openclaw-jobs.json'), 'utf8'));
  buildOpenclawDb(file, jobs);
  const res = readOpenclaw({ db: file, now: NOW });
  const salute = res.items.find((i) => i.key === 'cron:11111111-aaaa-4000-8000-000000000002');
  assert.equal(salute.last.outcome, 'error');
  assert.equal(salute.tech.exit, 1);
  const posta = res.items.find((i) => i.key === 'cron:11111111-aaaa-4000-8000-000000000001');
  assert.equal(posta.last.delivered, 'none'); // soppressa: niente da consegnare
  for (let k = 1; k < posta.runs.length; k++) assert.ok(posta.runs[k - 1].at >= posta.runs[k].at, 'runs dal più recente');
});

test('openclaw: not-delivered annunciato e non soppresso è failed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  const file = path.join(tmp, 'openclaw.sqlite');
  buildOpenclawDb(file, [{
    job_id: 'fail-1', name: 'prova-failed', enabled: 1, payload_kind: 'command',
    job: { schedule: { kind: 'every', everyMs: 60000 }, payload: { kind: 'command', argv: ['x'] }, delivery: { mode: 'announce', channel: 'whatsapp' } },
    state: { lastRunStatus: 'ok', lastDeliveryStatus: 'not-delivered', consecutiveErrors: 0 },
    receipts: [{ ago: 5, status: 'ok' }],
  }]);
  const res = readOpenclaw({ db: file, now: NOW });
  assert.equal(res.items[0].last.delivered, 'failed');
});

test('openclaw: db senza tabella cron_jobs è ok:false', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  const file = path.join(tmp, 'openclaw.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE altro (a TEXT)');
  db.close();
  const res = readOpenclaw({ db: file, now: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(res.items, []);
});

test('parità describe: when/cond/who/out/times come la foto', () => {
  const before = JSON.parse(fs.readFileSync(fix('automazioni-map-before.json'), 'utf8'));
  const { jobs } = JSON.parse(fs.readFileSync(fix('automations/openclaw-jobs.json'), 'utf8'));
  assert.equal(jobs.length, before.cron.length);
  jobs.forEach((r, i) => {
    const j = { id: r.job_id, name: r.name, enabled: !!r.enabled, ...r.job };
    const cond = condOf(j);
    assert.equal(whenOf(j.schedule), before.cron[i].when, `when ${r.name}`);
    assert.equal(cond, before.cron[i].cond, `cond ${r.name}`);
    assert.deepEqual(whoOf(j), before.cron[i].who, `who ${r.name}`);
    assert.equal(outOf(j), before.cron[i].out, `out ${r.name}`);
    assert.deepEqual(timesOfCron(j.schedule, cond), before.cron[i].times, `times ${r.name}`);
  });
  const ldir = fix('automations/launchd');
  const files = fs.readdirSync(ldir).filter((f) => f.endsWith('.plist')).sort();
  assert.equal(files.length, before.launchd.length);
  files.forEach((f, i) => {
    const p = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(ldir, f)], { encoding: 'utf8' }));
    assert.equal(p.Label, before.launchd[i].label);
    assert.deepEqual(timesOfLaunchd(p), before.launchd[i].times, `times ${f}`);
  });
  for (const [s, expected] of before.fps) assert.equal(fp(s), expected, `fp ${JSON.stringify(s)}`);
});

test('antenato: la foto viene prima della copia', (t) => {
  const addCommit = execFileSync('git', ['log', '--diff-filter=A', '--format=%H', '--', 'test/fixtures/automazioni-map-before.json'], { encoding: 'utf8' }).trim().split('\n')[0];
  assert.match(addCommit, /^[0-9a-f]{40}$/);
  execFileSync('git', ['merge-base', '--is-ancestor', addCommit, 'HEAD']); // esce non-zero se non è antenato
  const listed = execFileSync('git', ['ls-files', '--', 'src/automations/describe.mjs'], { encoding: 'utf8' }).trim();
  if (!listed) {
    t.skip('describe.mjs non ancora in git');
    return;
  }
  const descCommit = execFileSync('git', ['log', '--diff-filter=A', '--format=%H', '--', 'src/automations/describe.mjs'], { encoding: 'utf8' }).trim().split('\n')[0];
  execFileSync('git', ['merge-base', '--is-ancestor', addCommit, descCommit]);
});

test('parità cron-health: findings come il prima', () => {
  const facts = JSON.parse(fs.readFileSync(fix('cron-health/facts.json'), 'utf8'));
  const accepted = JSON.parse(fs.readFileSync(fix('cron-health/accept.json'), 'utf8'));
  const before = JSON.parse(fs.readFileSync(fix('cron-health/before.json'), 'utf8'));
  assert.deepStrictEqual(findings({ ...facts, accepted: [] }), before.raw);
  assert.deepStrictEqual(findings({ ...facts, accepted }), before.accepted);
});

test('launchd: 3 item, backup dal log, ogni15 in errore, watch spento', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-'));
  const logdir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-logs-'));
  const ldir = fix('automations/launchd');
  for (const f of fs.readdirSync(ldir)) {
    if (!f.endsWith('.plist')) continue;
    fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(ldir, f), 'utf8').replaceAll('LOGDIR', logdir));
  }
  const logDay = new Date(NOW);
  logDay.setDate(logDay.getDate() - 1);
  logDay.setHours(4, 33, 0, 0); // ieri 04:33
  const logFile = path.join(logdir, 'esempio-backup.log');
  fs.writeFileSync(logFile, 'riga di prova\n');
  fs.utimesSync(logFile, logDay, logDay);
  const list = 'PID\tStatus\tLabel\n-\t0\tcom.jarvis.esempio-backup\n-\t2\tcom.jarvis.esempio-ogni15\n';
  const res = readLaunchd({ dir: tmp, launchctlList: list, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.items.length, 3); // server KeepAlive nei servizi, .bak escluso
  assert.equal(res.services, 1);
  const backup = res.items.find((i) => i.key === 'launchd:com.jarvis.esempio-backup');
  assert.equal(backup.everyMs, 86400000);
  assert.equal(backup.last.at, logDay.getTime());
  const today = new Date(NOW);
  today.setHours(4, 32, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  assert.equal(backup.expectedLast, (today.getTime() <= NOW ? today : yesterday).getTime());
  assert.equal(backup.last.outcome, 'ok');
  const ogni15 = res.items.find((i) => i.key === 'launchd:com.jarvis.esempio-ogni15');
  assert.equal(ogni15.last.outcome, 'error');
  assert.equal(ogni15.tech.exit, 2);
  assert.equal(ogni15.who, 'Muse');
  const watch = res.items.find((i) => i.key === 'launchd:com.esempio.esempio-watch');
  assert.equal(watch.enabled, false); // assente da launchctl
});
