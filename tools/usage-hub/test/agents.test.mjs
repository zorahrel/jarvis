import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAgents, summarize, modelLabel, runStart, clip } from '../src/agents.mjs';

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const claudeLine = (ms, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(ms), cwd: '/x/zenocms', message: { model: 'claude-opus-5-5', usage: {} }, ...extra });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
  const claude = path.join(root, 'claude', '-x-zenocms'); fs.mkdirSync(claude, { recursive: true });
  // viva: toccata ora, Opus, con titolo
  fs.writeFileSync(path.join(claude, 'live.jsonl'), [claudeLine(NOW - 3 * 3600000), JSON.stringify({ type: 'ai-title', aiTitle: 'Rifare la hero' }), claudeLine(NOW - 1000)].join('\n') + '\n');
  // ferma: toccata 1 ora fa
  fs.writeFileSync(path.join(claude, 'old.jsonl'), claudeLine(NOW - 3600000) + '\n');
  fs.utimesSync(path.join(claude, 'old.jsonl'), new Date(NOW - 3600000), new Date(NOW - 3600000));
  // sottoagente OpenClaw: cwd dentro la radice
  const oc = path.join(root, 'claude', '-oc'); fs.mkdirSync(oc);
  fs.writeFileSync(path.join(oc, 'sub.jsonl'), JSON.stringify({ type: 'assistant', timestamp: iso(NOW - 60000), cwd: path.join(root, 'oc', 'workspace'), message: { model: 'claude-sonnet-5-5' } }) + '\n');
  // Codex di oggi
  const d = new Date(NOW); const p = (v) => String(v).padStart(2, '0');
  const cdx = path.join(root, 'codex', String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())); fs.mkdirSync(cdx, { recursive: true });
  fs.writeFileSync(path.join(cdx, 'rollout-1.jsonl'), JSON.stringify({ timestamp: iso(NOW - 120000), payload: { cwd: '/y/work-sot', model: 'gpt-6-luna' } }) + '\n');
  // Muse di oggi
  const ms = path.join(root, 'muse', String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()), 'abc'); fs.mkdirSync(ms, { recursive: true });
  fs.writeFileSync(path.join(ms, 'session.jsonl'), JSON.stringify({ payload: { record: { workspace_root: '/x/zenocms', model_id: 'muse-spark-1.3' } } }) + '\n');
  return { root, args: { now: NOW, claudeRoot: path.join(root, 'claude'), codexRoot: path.join(root, 'codex'), museRoot: path.join(root, 'muse'), ocRoot: path.join(root, 'oc') } };
}

test('agenti vivi da fixture: solo i transcript recenti, con modello, titolo e progetto', () => {
  const { args } = fixture();
  const { agents, lastSeen } = scanAgents({ ...args, queue: [{ status: 'running', provider: 'muse', project: 'zenocms', task: 'sweep', startedAt: NOW - 600000 }, { status: 'queued', project: 'zenocms', task: 'no' }] });
  const zeno = agents.filter((a) => a.project === 'zenocms');
  assert.deepEqual(zeno.map((a) => `${a.kind}:${a.model}`).sort(), ['coda:Muse', 'museagent:Muse', 'sessione:Opus']);
  assert.equal(zeno.find((a) => a.kind === 'sessione').title, 'Rifare la hero');
  assert.equal(agents.find((a) => a.project === 'openclaw/sottoagenti').model, 'Sonnet');
  assert.equal(agents.find((a) => a.provider === 'codex').project, 'work-sot');
  assert.equal(agents.length, 5); // la sessione ferma da 1 h non conta
  assert.ok(NOW - lastSeen.zenocms.at < 60000);
});

test('riassunto: conteggi per modello e avviso Opus con la sessione più lunga', () => {
  const { args } = fixture();
  const s = summarize(scanAgents(args).agents, { now: NOW }).zenocms;
  assert.equal(s.count, 2);
  assert.equal(s.opus, 1);
  assert.ok(s.opusMs < 5000); // il buco di 3 h azzera la durata
  assert.deepEqual(modelLabel('claude-fable-5-1'), 'Fable');
});

test('inizio del tratto continuo: una pausa di ore azzera la durata', () => {
  const t = (ms) => `{"timestamp":"${iso(ms)}"}`;
  const text = [t(NOW - 5 * 86400000), t(NOW - 40 * 60000), t(NOW - 20 * 60000), t(NOW - 1000)].join('\n');
  const s = runStart(text, 0);
  assert.ok(Math.abs(NOW - 40 * 60000 - s) < 1000);
});

test('titoli dei sottoagenti ripuliti da data e marcatori interni', async () => {
  const { agents } = scanAgents(fixture().args);
  assert.ok(agents.every((a) => !/GMT|<<<|\\n/.test(a.title)));
});

import { attachOpen, loadDesktopSessions, topicsByProject, desktopUrl } from '../src/agents.mjs';
import { labelFor } from '../src/live.mjs';

test('apertura: app desktop per id transcript, poi tab Topics per cartella, altrimenti dove gira', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
  const dir = path.join(root, 'acc', 'org'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_abc.json'), JSON.stringify({ sessionId: 'local_abc', cliSessionId: 'cli-1', title: 'Hero' }));
  const desktop = loadDesktopSessions(root);
  const agents = [
    { provider: 'claude', kind: 'sessione', cliId: 'cli-1', cwd: '/a' },
    { provider: 'claude', kind: 'sessione', cliId: 'cli-2', cwd: '/b' },
    { provider: 'claude', kind: 'sessione', cliId: 'cli-3', cwd: '/c' },
    { provider: 'claude', kind: 'sottoagente', cliId: 'cli-4', cwd: '/d' },
    { provider: 'codex', kind: 'codex', cwd: '/e' },
  ];
  attachOpen(agents, { desktop, topics: [{ sessionId: 'T1', cwd: '/b' }] });
  assert.equal(agents[0].open.url, desktopUrl('local_abc'));
  assert.equal(agents[1].open.via, 'tab Topics');
  assert.ok(agents[1].open.url.endsWith('/tab/chat/T1'));
  assert.ok(agents[2].where && !agents[2].open);
  assert.match(agents[3].where, /OpenClaw/);
  assert.match(agents[4].where, /Codex/);
});

test('tab Topics per progetto e nomi leggibili delle cartelle scratch', () => {
  const t = topicsByProject([{ source: 'topics', sessionId: 'S', cwd: '/x/zenocms', title: 'Home', busy: true }, { source: 'tmux', cwd: '/x/zenocms' }]);
  assert.equal(t.zenocms.length, 1);
  assert.equal(labelFor('scratch-2026-10-18-da2f0d').label, 'Prova del 18/10');
  assert.equal(labelFor('zenocms', { zenocms: { label: 'ZenoCMS' } }).label, 'ZenoCMS');
});

import { pickTopics } from '../src/agents.mjs';
test('più tab Topics nella stessa cartella: per titolo, poi l\'unico al lavoro, nel dubbio nessuno', () => {
  const tabs = [{ sessionId: 'A', cwd: '/s', title: 'Home page', busy: false }, { sessionId: 'B', cwd: '/s', title: 'Animazione applauso mani vs ve', busy: true }];
  assert.equal(pickTopics({ cwd: '/s', title: 'Animazione applauso mani vs vecchio Lottie' }, tabs).sessionId, 'B');
  assert.equal(pickTopics({ cwd: '/s', title: 'altro' }, tabs).sessionId, 'B');
  assert.equal(pickTopics({ cwd: '/s', title: 'altro' }, tabs.map((x) => ({ ...x, busy: false }))), null);
  assert.equal(pickTopics({ cwd: '/zz', title: 'x' }, tabs), null);
});

test('clip: il contesto iniettato dagli harness non diventa il titolo della sessione', () => {
  assert.equal(clip('# Environment You have been invoked in the following environment: - Primary working directory: /Users/x/Library'), '');
  assert.equal(clip(': - Primary working directory: /Users/x/Library/Application Support/Claude'), '');
  assert.equal(clip('Conversation info: ⟦openclaw:ctx⟧ ```json {\\"a\\":1}'), '');
  assert.equal(clip('Rifare la hero Conversation info: [openclaw:ctx] {}'), 'Rifare la hero');
  assert.equal(clip('Animazione applauso mani'), 'Animazione applauso mani');
});

test('sottoagenti di Claude Code e dei workflow: figli della sessione, subito sotto di lei', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { scanAgents, summarize } = await import('../src/agents.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sub-')), d = path.join(root, '-x-proj'), now = Date.now();
  const line = (o) => JSON.stringify(o) + '\n';
  fs.mkdirSync(path.join(d, 's1', 'subagents', 'workflows', 'wf1'), { recursive: true });
  fs.writeFileSync(path.join(d, 's1.jsonl'), line({ cwd: '/x/proj', type: 'user', message: { content: 'sessione madre' } }) + line({ message: { model: 'claude-opus-4' }, timestamp: new Date(now).toISOString(), aiTitle: 'Madre' }));
  fs.writeFileSync(path.join(d, 's1', 'subagents', 'agent-a1.jsonl'), line({ message: { model: 'claude-sonnet-4' } }));
  fs.writeFileSync(path.join(d, 's1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'scout', description: 'Cerca' }));
  fs.writeFileSync(path.join(d, 's1', 'subagents', 'agent-a2.jsonl'), line({ message: { model: 'claude-sonnet-4' } }));
  fs.writeFileSync(path.join(d, 's1', 'subagents', 'agent-a2.meta.json'), JSON.stringify({ description: 'Finito', finished: true }));
  fs.writeFileSync(path.join(d, 's1', 'subagents', 'workflows', 'wf1', 'agent-w1.jsonl'), line({ message: { model: 'claude-opus-4' } }));
  const { agents } = scanAgents({ now, claudeRoot: root, codexRoot: path.join(root, 'no'), museRoot: path.join(root, 'no'), ocRoot: '/nessuno' });
  const [p] = Object.values(summarize(agents, { now }));
  assert.deepEqual(p.list.map((a) => [a.kind, a.depth || 0, a.title]), [['sessione', 0, 'Madre'], ['sottoagente', 1, 'Cerca'], ['workflow', 2, '']]);
});

test('un sottoagente la cui sessione non è viva sta in cima, non sotto una sessione estranea', async () => {
  const { summarize } = await import('../src/agents.mjs');
  const now = Date.now();
  const list = [{ cliId: 'x', kind: 'sessione', model: 'Opus', provider: 'claude', project: 'p', startedAt: now, lastActivity: now },
    { cliId: 'k', parent: 'madre-ferma', depth: 1, kind: 'sottoagente', model: 'Opus', provider: 'claude', project: 'p', startedAt: now, lastActivity: now }];
  const [p] = Object.values(summarize(list, { now }));
  assert.deepEqual(p.list.map((a) => [a.cliId, a.depth || 0]), [['x', 0], ['k', 0]]);
});

test('openclawBucket: le chat di Jarvis tornano al loro bucket, i sottoagenti restano tali', async () => {
  const { openclawBucket } = await import('../src/agents.mjs');
  const resolve = (id) => ({ a: 'openclaw/whatsapp-diretta', b: 'openclaw/sub:PDF' }[id] || null);
  assert.equal(openclawBucket('openclaw/sottoagenti', 'a', { resolve }), 'openclaw/whatsapp-diretta');
  assert.equal(openclawBucket('openclaw/sottoagenti', 'b', { resolve }), 'openclaw/sottoagenti');
  assert.equal(openclawBucket('openclaw/sottoagenti', 'x', { resolve }), 'openclaw/sottoagenti');
  assert.equal(openclawBucket('jarvis', 'a', { resolve }), 'jarvis');
  assert.equal(openclawBucket('openclaw/sottoagenti', 'a', {}), 'openclaw/sottoagenti');
});

test('workLabel: il lavoro in parole, senza id, percorsi, comandi né preamboli', async () => {
  const { workLabel } = await import('../src/agents.mjs');
  assert.equal(workLabel('[cron:e2c88c80-2e8a-4e1c-a494-c15115846c6e outreach-sync] Esegui il conteggio e aggiorna Ti aspetta: lancia lo script'), 'Esegui il conteggio e aggiorna Ti aspetta');
  assert.equal(workLabel('Dalla Regia (sessione che coordina). Richiesta di Attilio, 24/10 13:20: sistema la tray. Poi fermati.'), 'Sistema la tray');
  assert.equal(workLabel('TASK (code on a clear spec, Python 3, in /Users/x/scripts/a.py) Scrivi il parser delle fatture'), 'Scrivi il parser delle fatture');
  assert.equal(workLabel('diag:chi-lancia'), 'Diagnosi: chi lancia');
  assert.equal(workLabel('In /Users/x/repo, apply these fixes from an independent review'), 'Apply these fixes from an independent review');
  assert.equal(workLabel('Home page'), 'Home page');
  assert.equal(workLabel('Tray: verifica UI/UX'), 'Tray: verifica UI/UX');
  assert.equal(workLabel(''), '');
  assert.ok(workLabel('parola '.repeat(15)).endsWith('…'));
});

test('scanAgents: le chiamate che ricavano il titolo di una card non sono agenti al lavoro', async () => {
  const { scanAgents } = await import('../src/agents.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-')); const dir = path.join(root, '-Users-x-proj'); fs.mkdirSync(dir);
  const line = (t) => JSON.stringify({ type: 'user', cwd: '/Users/x/proj', message: { role: 'user', content: t }, timestamp: new Date().toISOString() }) + '\n' + claudeLine(NOW - 1000, { cwd: '/Users/x/proj' }) + '\n';
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line('Da questa richiesta ricava un TITOLO breve per una card di lavoro: 3-6 parole'));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line('Sistema la tray'));
  const { agents } = scanAgents({ claudeRoot: root, codexRoot: path.join(root, 'no'), museRoot: path.join(root, 'no') });
  assert.deepEqual(agents.map((a) => a.title), ['Sistema la tray']);
});

test('summarize: claude -p è headless e senza lavoro; il testo di un prompt non diventa mai il nome del lavoro', () => {
  const list = [
    { project: 'p', provider: 'claude', model: 'Opus', kind: 'sessione', title: 'Apply these fixes from an independent review', titleFrom: 'prompt', startedAt: 1 },
    { project: 'p', provider: 'claude', model: 'Opus', kind: 'sessione', title: 'Tray UI', titleFrom: 'app', startedAt: 1 },
    { project: 'p', provider: 'claude', model: 'Sonnet', kind: 'sessione', title: 'Rifai i test', titleFrom: 'ai', headless: true, startedAt: 1 },
    { project: 'p', provider: 'codex', model: 'GPT', kind: 'codex', title: 'TASK scrivi il parser', startedAt: 1 },
  ];
  const out = summarize(list).p.list;
  assert.deepEqual(out.map((a) => [a.work, !!a.headless]), [[null, false], ['Tray UI', false], [null, true], [null, true]]);
});
