// Quando una card in review è di Attilio (28/10): solo se porta «aspetta: attilio» o nasce da una voce di Promemoria.
// Le altre non gli scrivono e non diventano ⚠; soprattutto, il cambio di regola non approva né sposta nessuna card.
//   node --test scripts/task-sync/task-sync.mia.test.mjs      (mutanti: sh scripts/task-sync/task-sync-mutant.sh)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Il modulo si può puntare a una copia mutata (task-sync-mutant.sh).
const M = await import(process.env.TASK_SYNC_MODULE ? pathToFileURL(process.env.TASK_SYNC_MODULE).href : './task-sync.mjs');
const { round, normCard, normRem, loadState, HOME, reviewMessage, askOf, isMine } = M;

const BOARD = 'attilio-test01';
const ALTRA = 'topics-app-x';

function fakeTopics(initial) {
  const tasks = new Map(initial.map((t) => [t.id, { projectId: BOARD, status: 'backlog', ...t }]));
  const writes = [];
  return {
    tasks, writes,
    async read(board, linked) {
      const cards = [...tasks.values()].filter((t) => t.projectId === board || t.status === 'review' || linked.includes(t.id)).map(normCard);
      return { cards, missing: new Set(linked.filter((id) => !tasks.has(id))) };
    },
    async create(b, task) { const id = randomUUID(); writes.push(['create', task.text]); tasks.set(id, { id, projectId: b, ...task }); return { id, dueSet: true }; },
    async patch(b, id, p) { writes.push(['patch', id, p]); Object.assign(tasks.get(id), 'status' in p ? { status: p.status } : {}); },
    async approve(b, id) { writes.push(['approve', id]); tasks.get(id).status = 'done'; },
    async comment(b, id, c) { writes.push(['comment', id, c]); },
  };
}

function fakeReminders(initial) {
  const items = new Map(initial.map((r) => [r.id, { listName: HOME, isCompleted: false, dueDate: null, notes: '', ...r }]));
  const writes = [];
  return {
    items, writes,
    read: () => [...items.values()].map(normRem),
    create({ list, title, notes }) { const id = randomUUID().toUpperCase(); writes.push(['add', title]); items.set(id, { id, listName: list, title, isCompleted: false, dueDate: null, notes: notes || '' }); return id; },
    edit(id, a) {
      writes.push(['edit', id, a]);
      const r = items.get(id);
      if (a.title) r.title = a.title;
      if (a.complete) r.isCompleted = true;
      if (a.incomplete) r.isCompleted = false;
    },
  };
}

// state: i collegamenti già concordati (uno stato «da prima della regola» si costruisce a mano).
function setup({ cards = [], rems = [], links = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-mia-'));
  fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify({ version: 1, links }));
  const topics = fakeTopics(cards), reminders = fakeReminders(rems);
  const journal = [], notified = [];
  const go = () => round({ topics, reminders, dir, board: BOARD, log: () => {}, journal: (e) => journal.push(...e), notify: (r) => notified.push(...r) });
  return { topics, reminders, journal, notified, go, dir };
}

const NON_SUA = { id: randomUUID(), text: 'Consegna di un agente', status: 'review', projectId: ALTRA, descriptionPreview: 'Fatto il ramo, prova allegata. Nessuna decisione.' };
const SUA = (extra = {}) => ({ id: randomUUID(), text: 'Mail a Acme', status: 'review', projectId: ALTRA, descriptionPreview: 'Bozza pronta.\naspetta: attilio — ok all\'invio della mail a Rossi?', ...extra });
const writesOf = (s) => ({ topics: s.topics.writes, rems: s.reminders.writes });

test('askOf e isMine: la riga «aspetta: attilio» o la nascita da Promemoria', () => {
  assert.equal(askOf('x\naspetta: attilio — ok all\'invio della mail?\ny'), 'ok all\'invio della mail?');
  assert.equal(askOf('Aspetta: Attilio: vedi il menu'), 'vedi il menu');
  assert.equal(askOf('non aspetta: attilio qui'), null, 'la riga deve iniziare col marcatore');
  assert.equal(isMine('Da Promemoria «Jarvis/ActiveTasks» · 0F30F228'), true);
  assert.equal(isMine('Fatto, tutto verde.'), false);
});

test('una review che non è di Attilio non diventa ⚠, non gli scrive, e va nel diario una volta sola', async () => {
  const s = setup({ cards: [NON_SUA], links: { x: { rid: 'x', list: HOME, scope: 'board', base: { title: 'x', cls: 'done', due: null } } } });
  await s.go();
  const again = await s.go();
  assert.deepEqual(s.reminders.items.size, 0, 'nessuna voce in Promemoria');
  assert.deepEqual(s.notified, [], 'nessun messaggio');
  assert.equal(s.journal.filter((e) => e.ref === NON_SUA.id).length, 1, 'una riga di diario, non una per giro');
  assert.deepEqual(s.topics.writes, [], 'la card non si tocca');
  assert.deepEqual(again.reviews, []);
});

test('una review con «aspetta: attilio» diventa ⚠ e il messaggio porta la domanda', async () => {
  const c = SUA();
  const s = setup({ cards: [c], links: { x: { rid: 'x', list: HOME, scope: 'board', base: { title: 'x', cls: 'done', due: null } } } });
  await s.go();
  const [rem] = [...s.reminders.items.values()];
  assert.equal(rem.title, '⚠ Mail a Acme');
  assert.equal(s.notified.length, 1);
  const text = reviewMessage(s.notified);
  assert.match(text, /Aspetta te: 1/);
  assert.match(text, /Mail a Acme\n {2}ok all'invio della mail a Rossi\?/);
  assert.doesNotMatch(text, /Topics/, 'non lo manda su Topics');
});

test('su una board propria: la review non sua sta come ► (niente ⚠, niente avviso), la sua come ⚠', async () => {
  const a = { id: randomUUID(), text: 'Agente A', status: 'in_progress' };
  const b = { id: randomUUID(), text: 'Agente B', status: 'in_progress', description: 'aspetta: attilio — guarda la tray' };
  const s = setup({ cards: [a, b] });
  await s.go();
  s.topics.tasks.get(a.id).status = 'review'; s.topics.tasks.get(b.id).status = 'review';
  s.topics.tasks.get(b.id).descriptionPreview = 'aspetta: attilio — guarda la tray';
  await s.go();
  const titles = Object.fromEntries([...s.reminders.items.values()].map((r) => [r.title.replace(/^\S+ /, ''), r.title]));
  assert.equal(titles['Agente A'], '► Agente A');
  assert.equal(titles['Agente B'], '⚠ Agente B');
  assert.deepEqual(s.notified.map((c) => c.title), ['Agente B']);
  assert.deepEqual(s.topics.writes, [], 'nessuna card spostata');
});

test('board-card e board-notte riconoscono la riga «aspetta: attilio» con lo stesso prefisso di task-sync', () => {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const prefix = '[ \\t>*_-]*aspetta:';
  for (const f of ['scripts/board-card', 'tools/usage-hub/bin/board-notte']) {
    assert.ok(fs.readFileSync(path.join(dir, f), 'utf8').includes(prefix), `${f} usa lo stesso prefisso`);
  }
  assert.ok(fs.readFileSync(new URL('./task-sync.mjs', import.meta.url), 'utf8').includes(prefix));
  for (const t of ['> aspetta: attilio — x', '- aspetta: attilio', '**aspetta: attilio']) assert.ok(isMine(t), t);
});

test('PERICOLO: una ⚠ rimasta di una card non più sua non la approva né la sposta (voce aperta, completata, o card che torna in corso)', async () => {
  const c = { ...NON_SUA };
  const rid = 'LEGACY01-0000';
  const links = { [c.id]: { rid, list: HOME, scope: 'review', base: { title: c.text, cls: 'review', due: null } } };
  const s = setup({ cards: [c], rems: [{ id: rid, title: `⚠ ${c.text}`, notes: `x · Topics ${c.id.slice(0, 8)} · ${ALTRA}` }], links });
  await s.go();
  assert.deepEqual(writesOf(s), { topics: [], rems: [] }, 'prima volta con la regola nuova: niente scritture');
  // Attilio la completa dal telefono: prima approvava la card.
  s.reminders.items.get(rid).isCompleted = true;
  await s.go(); await s.go();
  assert.deepEqual(s.topics.writes, [], 'completare la ⚠ non approva');
  assert.equal(s.reminders.items.get(rid).isCompleted, true, 'e la voce completata resta completata');
  assert.equal(s.topics.tasks.get(c.id).status, 'review');
  // La card esce da review: il giro non la chiude né la riporta indietro.
  s.topics.tasks.get(c.id).status = 'in_progress';
  await s.go();
  assert.deepEqual(s.topics.writes, []);
  assert.equal(s.topics.tasks.get(c.id).status, 'in_progress');
});

test('PERICOLO: la ⚠ aperta di una card non più sua resta finché la card esce da review, poi si chiude da sola', async () => {
  const c = { ...NON_SUA };
  const rid = 'LEGACY02-0000';
  const links = { [c.id]: { rid, list: HOME, scope: 'review', base: { title: c.text, cls: 'review', due: null } } };
  const s = setup({ cards: [c], rems: [{ id: rid, title: `⚠ ${c.text}` }], links });
  await s.go(); await s.go();
  assert.equal(s.reminders.items.get(rid).title, `⚠ ${c.text}`);
  assert.equal(s.reminders.items.get(rid).isCompleted, false);
  s.topics.tasks.get(c.id).status = 'done';
  await s.go();
  assert.equal(s.reminders.items.get(rid).isCompleted, true, 'la card chiusa chiude la sua voce');
  assert.deepEqual(s.topics.writes, []);
});

test('PERICOLO: sulla board propria una ⚠ vecchia di una review non sua scende a ► senza toccare la card, anche se era stata completata', async () => {
  for (const done of [false, true]) {
    const c = { id: randomUUID(), text: 'Lavoro di Jarvis', status: 'review' };
    const rid = `LEGACY03${done ? 'B' : 'A'}-0000`;
    const links = { [c.id]: { rid, list: HOME, scope: 'board', base: { title: c.text, cls: 'review', due: null } } };
    const s = setup({ cards: [c], rems: [{ id: rid, title: `⚠ ${c.text}`, isCompleted: done }], links });
    await s.go(); await s.go();
    assert.deepEqual(s.topics.writes, [], `card intatta (voce completata: ${done})`);
    assert.equal(s.topics.tasks.get(c.id).status, 'review');
    assert.equal(s.reminders.items.get(rid).title, `► ${c.text}`);
    assert.deepEqual(s.notified, []);
  }
});

test('PERICOLO: la ⚠ completata mentre la card non era sua non diventa un\'approvazione quando la card prende «aspetta: attilio»', async () => {
  const c = { ...NON_SUA };
  const rid = 'LEGACY04-0000';
  const links = { [c.id]: { rid, list: HOME, scope: 'review', base: { title: c.text, cls: 'review', due: null } } };
  const s = setup({ cards: [c], rems: [{ id: rid, title: `⚠ ${c.text}`, notes: `x · Topics ${c.id.slice(0, 8)} · ${ALTRA}` }], links });
  await s.go();
  s.reminders.items.get(rid).isCompleted = true; // gesto fatto quando la card non era sua
  await s.go();
  // Ora la card porta la domanda e resta in review.
  s.topics.tasks.get(c.id).descriptionPreview = 'aspetta: attilio — scegli il server';
  await s.go(); await s.go();
  assert.deepEqual(s.topics.writes, [], 'la card non viene approvata');
  assert.equal(s.topics.tasks.get(c.id).status, 'review');
  assert.equal(s.reminders.items.get(rid).isCompleted, false, 'la voce si riapre');
  assert.equal(s.reminders.items.get(rid).title, `⚠ ${c.text}`);
  assert.deepEqual(s.notified.map((x) => x.title), [c.text], 'e gli arriva la domanda, una volta sola');
});

test('PERICOLO: una ⚠ già completata da prima della regola, su una card non sua, non approva al primo giro', async () => {
  const c = { ...NON_SUA };
  const rid = 'LEGACY06-0000';
  const links = { [c.id]: { rid, list: HOME, scope: 'review', base: { title: c.text, cls: 'review', due: null } } };
  const s = setup({ cards: [c], rems: [{ id: rid, title: `⚠ ${c.text}`, isCompleted: true, notes: `x · Topics ${c.id.slice(0, 8)} · ${ALTRA}` }], links });
  await s.go();
  assert.deepEqual(s.topics.writes, []);
  assert.equal(s.topics.tasks.get(c.id).status, 'review');
});

test('la card che diventa sua restando in review riceve il WhatsApp con la domanda (anche se la voce era una ⚠ vecchia)', async () => {
  const c = { ...NON_SUA };
  const rid = 'LEGACY05-0000';
  const links = { [c.id]: { rid, list: HOME, scope: 'review', base: { title: c.text, cls: 'review', due: null } } };
  const s = setup({ cards: [c], rems: [{ id: rid, title: `⚠ ${c.text}`, notes: `x · Topics ${c.id.slice(0, 8)} · ${ALTRA}` }], links });
  await s.go();
  assert.deepEqual(s.notified, []);
  s.topics.tasks.get(c.id).descriptionPreview = 'aspetta: attilio — firma qui';
  await s.go(); await s.go();
  assert.deepEqual(s.notified.map((x) => x.title), [c.text]);
  assert.equal(s.notified[0].ask, 'firma qui');
  assert.deepEqual(s.topics.writes, []);
});

test('la card nata da una voce ⚠ di Promemoria resta ⚠ e completarla continua ad approvarla', async () => {
  const c = { id: randomUUID(), text: 'Da decidere', status: 'review', projectId: ALTRA, descriptionPreview: 'Da Promemoria «Jarvis/ActiveTasks» · 0F30F228\n\nscegli' };
  const s = setup({ cards: [c], links: { x: { rid: 'x', list: HOME, scope: 'board', base: { title: 'x', cls: 'done', due: null } } } });
  await s.go();
  const [rem] = [...s.reminders.items.values()];
  assert.equal(rem.title, '⚠ Da decidere');
  rem.isCompleted = true;
  await s.go();
  assert.deepEqual(s.topics.writes.filter((w) => w[0] === 'approve'), [['approve', c.id]]);
});
