// Prove dei guasti trovati dal verificatore il 24/10: doppioni dopo un guasto a metà, scritture rifiutate da Topics,
// ☐ di scadenze-sync rimessi dopo una cancellazione. Restano fuori, di proposito, i casi che richiedono INSIEME lo stato
// perso e una card spostata su un'altra board o una voce spostata in una lista non sincronizzata.
//   node --test scripts/task-sync/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { round, normCard, normRem, localDue, loadState, HOME } from './task-sync.mjs';
import http from 'node:http';
import { topicsSide } from './task-sync.mjs';
const { plan: scadPlan } = await import(path.join(os.homedir(), '.openclaw/bin/scadenze-sync.mjs'));

const BOARD = 'attilio-test01';
const ARMONIA = '🟡 Armonia';

function fromLocal(s) {
  const [d, hm] = s.split(' ');
  for (const off of ['+02:00', '+01:00']) { const iso = new Date(`${d}T${hm}:00${off}`).toISOString(); if (localDue(iso) === s) return iso; }
  throw new Error(`data locale impossibile: ${s}`);
}
function fakeTopics(initial = []) {
  const tasks = new Map(initial.map((t) => [t.id, { projectId: BOARD, status: 'backlog', ...t }]));
  const writes = [];
  const side = {
    tasks, writes, down: false, failDue: false, approveGate: null, subtasksOpen: new Set(),
    async read(board, linked) {
      if (side.down) throw new Error('connect ECONNREFUSED 127.0.0.1:3333');
      // come il vero: board propria + feed delle review + le collegate una per una
      const cards = [...tasks.values()].filter((t) => t.projectId === board || t.status === 'review' || linked.includes(t.id)).map(normCard);
      return { cards, missing: new Set(linked.filter((id) => !tasks.has(id))) };
    },
    async create(board, task, due) {
      const id = randomUUID();
      writes.push(['create', task.text]);
      tasks.set(id, { id, projectId: board, text: task.text, status: task.status, description: task.description, dueDate: null });
      if (!due) return { id, dueSet: true };
      if (side.failDue) return { id, dueSet: false };
      tasks.get(id).dueDate = new Date(due).toISOString();
      return { id, dueSet: true };
    },
    async patch(board, id, p) {
      writes.push(['patch', id, p]);
      const t = tasks.get(id);
      // services/tasks.ts:3872 — done con sottotask aperti: 400 open_subtasks, per qualunque attore
      if (p.status === 'done' && side.subtasksOpen.has(id)) throw Object.assign(new Error('Topics PATCH: 400 open_subtasks'), { status: 400 });
      if ('status' in p) t.status = p.status;
      if ('text' in p) t.text = p.text;
      if ('dueDate' in p) t.dueDate = p.dueDate;
    },
    async approve(board, id) {
      writes.push(['approve', id]);
      // tasks-board.ts:625 checksRedGate / services/tasks.ts:4526 open_subtasks
      if (side.approveGate) throw Object.assign(new Error(`Topics POST review: 409 ${side.approveGate}`), { status: 409 });
      tasks.get(id).status = 'done';
    },
    async comment(board, id, c) { writes.push(['comment', id, c]); },
  };
  return side;
}
function fakeReminders(initial = []) {
  const items = new Map(initial.map((r) => [r.id, { listName: HOME, isCompleted: false, dueDate: null, notes: '', ...r }]));
  const writes = [];
  const side = {
    items, writes, down: false,
    read() { if (side.down) throw new Error('remindctl: accesso negato'); return [...items.values()].map(normRem); },
    create({ list, title, due, notes }) {
      const id = randomUUID().toUpperCase();
      writes.push(['add', title]);
      items.set(id, { id, listName: list, title, isCompleted: false, dueDate: due ? new Date(due).toISOString() : null, notes: notes || '' });
      return id;
    },
    edit(id, a) {
      writes.push(['edit', id, a]);
      const r = items.get(id);
      if (a.title) r.title = a.title;
      if (a.due) r.dueDate = fromLocal(a.due);
      if (a.clearDue) r.dueDate = null;
      if (a.complete) r.isCompleted = true;
      if (a.incomplete) r.isCompleted = false;
    },
  };
  return side;
}
function setup({ cards = [], rems = [], state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-guasti-'));
  if (state) fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify(state));
  const topics = fakeTopics(cards), reminders = fakeReminders(rems);
  const journal = [], notified = [];
  const go = (extra = {}) => round({ topics, reminders, dir, board: BOARD, log: () => {}, journal: (e) => journal.push(...e), notify: (r) => notified.push(...r), ...extra });
  // «stato perso»: links.json sparisce (spostato, non cancellato)
  const loseState = () => fs.renameSync(path.join(dir, 'links.json'), path.join(dir, `links.json.lost-${Date.now()}`));
  return { dir, topics, reminders, journal, notified, go, loseState, state: () => loadState(dir) };
}
const openCards = (t) => [...t.tasks.values()].filter((c) => c.status !== 'done');
const openRems = (r) => [...r.items.values()].filter((x) => !x.isCompleted);

// ── Doppioni ────────────────────────────────────────────────────────────────

test('A. stato perso + card in review su un\'altra board: nessun doppione', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Model dropdown: routing ON', status: 'review', projectId: 'topics-app-x', description: 'aspetta: attilio — ok a vista?' }] });
  await s.go(); await s.go();
  assert.equal(openRems(s.reminders).length, 1);
  s.loseState();
  await s.go(); await s.go(); await s.go();
  assert.equal(openCards(s.topics).length, 1, `card aperte: ${openCards(s.topics).map((c) => `${c.projectId}:${c.text}`).join(' | ')}`);
  assert.equal(openRems(s.reminders).length, 1, `voci aperte: ${openRems(s.reminders).map((r) => r.title).join(' | ')}`);
});

test('B. remindctl add scrive ma risponde male (timeout) per una card in review di un\'altra board: nessun doppione', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Approva il redesign', status: 'review', projectId: 'topics-app-x', description: 'aspetta: attilio — ok a vista?' }], state: { version: 1, links: {} } });
  const real = s.reminders.create;
  s.reminders.create = (o) => { real(o); throw new Error('Command failed: remindctl add ... ETIMEDOUT'); };
  await s.go();
  s.reminders.create = real;
  await s.go(); await s.go();
  assert.equal(openCards(s.topics).length, 1, `card aperte: ${openCards(s.topics).map((c) => `${c.projectId}:${c.text}`).join(' | ')}`);
  assert.equal(openRems(s.reminders).length, 1, `voci aperte: ${openRems(s.reminders).map((r) => r.title).join(' | ')}`);
});

test('B0 (controllo). stesso guasto per una card di BOARD: il marcatore la ricollega', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Card di board', status: 'backlog' }], state: { version: 1, links: {} } });
  const real = s.reminders.create;
  s.reminders.create = (o) => { real(o); throw new Error('ETIMEDOUT'); };
  await s.go();
  s.reminders.create = real;
  await s.go(); await s.go();
  assert.equal(openCards(s.topics).length, 1);
  assert.equal(openRems(s.reminders).length, 1);
});

test('C. POST di Topics va a segno ma la risposta si perde, e Topics rinomina la card (titoloInSottofondo): nessun doppione', async () => {
  const long = '⚠ CLIP Whop: pilota ok di Attilio, Jarvis prepara piano, prima clip e guida per l\'account';
  const s = setup({ rems: [{ id: 'R1AAAAAA-0000', title: long, notes: 'Attilio 23/10: sì al pilota. L\'account lo crea lui, Jarvis prepara il resto e glielo manda.' }], state: { version: 1, links: {} } });
  const real = s.topics.create;
  s.topics.create = async (b, task, due) => {
    const made = await real(b, task, due);
    // Titolo > 60 e descrizione più lunga: Topics lo riscrive in sottofondo (task-title.ts:66-71)
    s.topics.tasks.get(made.id).text = 'Pilota con approvazione di Attilio sulle pubblicazioni';
    throw new Error('Topics /api/boards/x/tasks: nessuna risposta in 15 s');
  };
  await s.go();
  s.topics.create = real;
  await s.go(); await s.go();
  assert.equal(openCards(s.topics).length, 1, `card aperte: ${openCards(s.topics).map((c) => c.text).join(' | ')}`);
  assert.equal(openRems(s.reminders).length, 1, `voci aperte: ${openRems(s.reminders).map((r) => r.title).join(' | ')}`);
});

test('F. scadenze-sync + ☐ cancellato dal telefono: niente seconda card', async () => {
  const s = setup({ state: { version: 1, links: {} } });
  const jobs = [{ id: 'b529fdef-0000-0000-0000-000000000000', name: 'pmi-giro6-risposte', enabled: true, schedule: { kind: 'at', at: '2026-10-28T08:00:00Z' }, payload: { message: 'Controllo risposte PMI giro 6. Leggi la casella.' } }];
  const scad = () => {
    const raw = [...s.reminders.items.values()].filter((r) => r.listName === HOME);
    for (const a of scadPlan(jobs, raw)) {
      if (a.op === 'add') s.reminders.create({ list: HOME, title: a.title, due: fromLocal(a.due), notes: a.notes });
      if (a.op === 'due') s.reminders.edit(a.id, { due: a.due });
      if (a.op === 'complete') s.reminders.edit(a.id, { complete: true });
    }
  };
  scad(); await s.go(); scad(); await s.go();
  assert.equal(s.topics.tasks.size, 1);
  const [rid] = [...s.reminders.items.keys()];
  s.reminders.items.delete(rid); // Attilio lo toglie dal telefono
  await s.go(); // card chiusa, come da progetto
  scad(); // il job vive ancora: nessun ☐ marcato aperto né chiuso → lo rimette
  await s.go(); scad(); await s.go();
  const cards = [...s.topics.tasks.values()].map((c) => `${c.status}:${c.text}`);
  assert.equal(s.topics.tasks.size, 1, `card per lo stesso job: ${cards.join(' | ')}`);
});

// ── Convergenza ─────────────────────────────────────────────────────────────

test('G. card in review di un\'altra board, voce spostata in 🟡 Armonia, titolo cambiato su Topics: converge', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Approva la landing', status: 'review', projectId: 'mc-x', description: 'aspetta: attilio — ok a vista?' }], state: { version: 1, links: {} } });
  await s.go();
  openRems(s.reminders)[0].listName = ARMONIA; // Attilio la sposta nella lista del progetto
  await s.go();
  s.topics.tasks.get(id).text = 'Approva la landing v2';
  await s.go();
  const counts = [];
  for (let i = 0; i < 5; i++) { s.reminders.writes.length = 0; await s.go(); counts.push(s.reminders.writes.length); }
  assert.deepEqual(counts, [0, 0, 0, 0, 0], `scritture in Promemoria per giro: ${counts}; ultima: ${JSON.stringify(s.reminders.writes.at(-1))}`);
});

test('H. ⚠ completato sul telefono ma Topics rifiuta l\'approvazione (check rossi): converge', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Deploy Sito Demo', status: 'review', projectId: 'sitodemo-x', description: 'aspetta: attilio — ok a vista?' }], state: { version: 1, links: {} } });
  await s.go();
  openRems(s.reminders)[0].isCompleted = true;
  s.topics.approveGate = 'checks_red';
  const tries = [];
  for (let i = 0; i < 4; i++) { s.topics.writes.length = 0; await s.go().catch(() => {}); tries.push(s.topics.writes.filter((w) => w[0] === 'approve').length); }
  assert.deepEqual(tries, [1, 0, 0, 0], `approvazioni tentate per giro: ${tries}; errori nel diario: ${s.journal.filter((e) => e.kind === 'errore').length}`);
});

test('I. voce completata sul telefono, card con sottotask aperti (400 open_subtasks): converge', async () => {
  const s = setup({ rems: [{ id: 'R1AAAAAA-0000', title: '► Sito armonia.io' }] });
  await s.go();
  const [card] = [...s.topics.tasks.values()];
  s.topics.subtasksOpen.add(card.id);
  s.reminders.items.get('R1AAAAAA-0000').isCompleted = true;
  const tries = [];
  for (let i = 0; i < 4; i++) { s.topics.writes.length = 0; await s.go(); tries.push(s.topics.writes.filter((w) => w[0] === 'patch').length); }
  assert.deepEqual(tries, [1, 0, 0, 0], `PATCH done tentate per giro: ${tries}`);
});

// ── Lista per lista, e il lato Topics vero ───────────────────────────────────

test('una lista che risponde vuota per un guasto non chiude le sue card, anche sotto la soglia globale', async () => {
  const s = setup({ rems: [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `RA${n}AAAAA-0000`, title: `Voce di Jarvis ${n}` })),
    ...[1, 2, 3].map((n) => ({ id: `RB${n}AAAAA-0000`, title: `Voce di Armonia ${n}`, listName: '🟡 Armonia' })),
  ] });
  await s.go(); await s.go(); // il secondo giro scrive la lista nei collegamenti
  for (const [id, r] of s.reminders.items) if (r.listName === '🟡 Armonia') s.reminders.items.delete(id);
  s.topics.writes.length = 0;
  await assert.rejects(s.go(), /🟡 Armonia/);
  assert.deepEqual(s.topics.writes, [], '3 su 10 sono sotto la soglia globale, ma sono tutta la lista: nessuna card chiusa');
});

test('il lato Topics crea la card senza descrizione e la aggiunge dopo, così Topics non riscrive il titolo', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { seen.push([req.method, req.url, body ? JSON.parse(body) : null]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'card-1' })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const t = topicsSide({ base: `http://127.0.0.1:${srv.address().port}` });
    const made = await t.create('attilio-x', { text: 'Patto Armonia: versione con riserva fissa, Jarvis prepara e manda ad Attilio', description: 'Da Promemoria «Jarvis/ActiveTasks» · ABCDEF12\n\nnota lunga', status: 'backlog' }, '2026-10-30T09:00Z');
    assert.deepEqual(made, { id: 'card-1', dueSet: true });
    const [post, patch] = seen;
    assert.equal(post[0], 'POST');
    assert.equal(post[2].description, undefined, 'alla nascita niente descrizione: è ciò che fa partire la rinomina');
    assert.equal(patch[0], 'PATCH');
    assert.match(patch[2].description, /^Da Promemoria/);
    assert.equal(patch[2].dueDate, '2026-10-30T09:00:00.000Z');
  } finally { srv.close(); }
});
