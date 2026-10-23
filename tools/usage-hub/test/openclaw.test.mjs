import '../test-support/isolate-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeKey, sniffFirstMessage, bucketName, buildIndex, makeResolver, firstUserText, museFirstText, OTHER } from '../src/openclaw.mjs';
import { scanProjects } from '../src/usage.mjs';
import { scanMuse } from '../src/muse.mjs';

// Tutti i dati qui sono finti: nessun nome o numero reale.
const SUB_KEY = 'agent:main:subagent:00000000-0000-4000-8000-000000000001';
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (text) => ({ type: 'user', message: { content: text } });
const usage = (cwd, ts = new Date().toISOString()) => ({ timestamp: ts, cwd, message: { usage: { input_tokens: 100, output_tokens: 10 } } });

test('session keys map to kinds', () => {
  assert.equal(describeKey('agent:main:whatsapp:direct:+39000').kind, 'wa-direct');
  assert.deepEqual(describeKey('agent:main:whatsapp:group:123@g.us'), { kind: 'wa-group', ref: '123@g.us' });
  assert.deepEqual(describeKey('agent:main:discord:channel:555'), { kind: 'discord', ref: '555' });
  assert.equal(describeKey('agent:main:discord:channel:555:heartbeat').kind, 'heartbeat');
  assert.equal(describeKey('agent:main:cron:00000000-0000-4000-8000-000000000002:run:x').kind, 'cron');
  assert.deepEqual(describeKey(SUB_KEY, 'fix login'), { kind: 'sub', ref: 'fix login' });
  assert.equal(describeKey('agent:main:something-else').kind, 'other');
});

test('first message sniffing', () => {
  const ctx = (o) => `Conversation info: x\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n\nhi`;
  assert.deepEqual(sniffFirstMessage(ctx({ chat_id: 'channel:777', group_subject: '#dev' })), { kind: 'discord', ref: '777', subject: '#dev' });
  assert.equal(sniffFirstMessage(ctx({ chat_id: '999@g.us' })).kind, 'wa-group');
  assert.equal(sniffFirstMessage(ctx({ chat_id: '+39111' })).kind, 'wa-direct');
  assert.equal(sniffFirstMessage('[cron:00000000-0000-4000-8000-000000000002 nightly] go').kind, 'cron');
  assert.equal(sniffFirstMessage('[Mon] [Subagent Context] you are\n\n[Subagent Task]\n\nBuild the widget\nmore').ref, 'Build the widget');
  assert.equal(sniffFirstMessage('Follow the heartbeat monitor scratch').kind, 'heartbeat');
  assert.equal(sniffFirstMessage('[Inter-session message] sourceSession=agent:main:discord:channel:42 x').ref, '42');
  assert.equal(sniffFirstMessage('Lavori nel repository /tmp/some/repo-x (Next)').ref, 'repo-x');
  assert.equal(sniffFirstMessage('Test tecnico del guardrail').kind, 'test');
  assert.equal(sniffFirstMessage('hello there').kind, 'other');
});

test('bucket names use local labels, then runtime subjects, then generic names', () => {
  assert.equal(bucketName({ kind: 'discord', ref: '555' }, { labels: { 555: 'ops' } }), 'openclaw/discord:ops');
  assert.equal(bucketName({ kind: 'discord', ref: '555' }, { subjects: { 555: '#dev' } }), 'openclaw/discord:#dev');
  assert.equal(bucketName({ kind: 'discord', ref: '5551234' }, {}), 'openclaw/discord:canale-1234');
  assert.equal(bucketName({ kind: 'wa-direct' }, {}), 'openclaw/whatsapp-diretta');
  assert.equal(bucketName({ kind: 'cron', ref: 'abcdef12-0000' }, { cronNames: { 'abcdef12-0000': 'nightly' } }), 'openclaw/cron:nightly');
  assert.equal(bucketName({ kind: 'cron', ref: 'abcdef12-0000' }, { cronNames: { 'abcdef12-0000': 'heartbeat-main' } }), 'openclaw/heartbeat');
  assert.equal(bucketName({ kind: 'other' }, {}), OTHER);
});

test('index maps CLI session ids from entries', () => {
  const { byCliId } = buildIndex([{ session_key: SUB_KEY, label: 'job', entry: { cliSessionIds: { 'claude-cli': 'c-1' }, cliSessionBindings: { x: { id: '2'.repeat(36) } } } }]);
  assert.equal(byCliId.get('c-1').ref, 'job');
  assert.ok(byCliId.has('2'.repeat(36)));
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  const root = path.join(dir, 'oc-root');
  const proj = path.join(dir, 'projects', '-fake-oc-root');
  fs.mkdirSync(proj, { recursive: true });
  const w = (id, ...rows) => fs.writeFileSync(path.join(proj, `${id}.jsonl`), jl(...rows));
  w('indexed', user('whatever'), usage(root));
  w('chat', user('Conversation info: x\n```json\n{"chat_id":"channel:9","group_subject":"#dev"}\n```\nhi'), usage(root), usage(root));
  w('mystery', user('hello'), usage(root));
  w('elsewhere', user('Test tecnico'), usage(path.join(dir, 'other-cwd')));
  return { dir, root, projects: path.join(dir, 'projects') };
}

test('scan splits the OpenClaw root by work and leaves other cwds alone', async () => {
  const f = fixture();
  const rows = [{ session_key: SUB_KEY, label: 'job', entry: { cliSessionIds: { 'claude-cli': 'indexed' } } }];
  const oc = await makeResolver({ root: f.root, labels: { 9: 'ops' } }, { rows, cronNames: {} });
  const out = scanProjects({ root: f.projects, sinceMs: 0, openclaw: oc });
  assert.equal(out['openclaw/sub:job'].requests, 1);
  assert.equal(out['openclaw/discord:ops'].requests, 2);
  assert.equal(out[OTHER].requests, 1);
  assert.equal(out['other-cwd'].requests, 1);
  assert.ok(!out['oc-root']);
  // "altro" deve restare marginale: qui 1 richiesta su 4 è il caso peggiore del fixture, con dati reali < 3%.
});

test('without the resolver the root stays one project (old behaviour)', () => {
  const f = fixture();
  const out = scanProjects({ root: f.projects, sinceMs: 0 });
  assert.equal(out['oc-root'].requests, 4);
});

test('firstUserText reads only the head of a jsonl', () => {
  const f = fixture();
  assert.equal(firstUserText(path.join(f.projects, '-fake-oc-root', 'mystery.jsonl')), 'hello');
  assert.equal(firstUserText('/nonexistent/file.jsonl'), '');
});

test('Muse sessions of the root: indexed ones by label, unknown ones are manual work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-muse-'));
  const root = path.join(dir, 'oc-root');
  const day = path.join(dir, 'sessions', '2026', '10', '13');
  const meta = { payload_type: 'runtime.session.metadata', payload: { record: { workspace_root: root } } };
  const done = { payload_type: 'runtime.session', recorded_at: Date.now() * 1000, payload: { event: { kind: 'model_completed', model: 'muse-wonder-1.0', usage: { input_tokens: 5, output_tokens: 1 } } } };
  const intent = (text) => ({ payload_type: 'runtime.user_intent.accepted', payload: { refill_blocks: [{ kind: 'text', text }] } });
  for (const [id, first] of [['m-idx', 'x'], ['m-hand', 'ci sei?']]) {
    fs.mkdirSync(path.join(day, id), { recursive: true });
    fs.writeFileSync(path.join(day, id, 'session.jsonl'), jl(meta, intent(first), done));
  }
  assert.equal(museFirstText(path.join(day, 'm-hand', 'session.jsonl')), 'ci sei?');
  const rows = [{ session_key: SUB_KEY, label: 'job', entry: { cliSessionIds: { 'muse-cli': 'm-idx' } } }];
  const oc = await makeResolver({ root }, { rows, cronNames: {} });
  const out = scanMuse({ root: path.join(dir, 'sessions'), sinceMs: 0, openclaw: oc });
  assert.equal(out['openclaw/sub:job'].requests, 1);
  assert.equal(out['openclaw/interattivo'].requests, 1);
});

test('the leftover bucket stays under 3% when most sessions are recognisable', async () => {
  const f = fixture();
  const proj = path.join(f.projects, '-fake-oc-root');
  const many = Array.from({ length: 100 }, () => usage(f.root));
  fs.writeFileSync(path.join(proj, 'big.jsonl'), jl(user('Conversation info: x\n```json\n{"chat_id":"+39000"}\n```'), ...many));
  fs.rmSync(path.join(proj, 'mystery.jsonl'));
  fs.writeFileSync(path.join(proj, 'mystery.jsonl'), jl(user('hello'), usage(f.root)));
  const oc = await makeResolver({ root: f.root }, { rows: [], cronNames: {} });
  const out = scanProjects({ root: f.projects, sinceMs: 0, openclaw: oc });
  const total = Object.entries(out).filter(([n]) => n.startsWith('openclaw/')).reduce((s, [, p]) => s + p.requests, 0);
  assert.ok(out[OTHER].requests / total < 0.03, `${out[OTHER].requests}/${total}`);
});
