// Prove del sync con due lati finti in memoria. node --test scripts/task-sync/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { round, normCard, normRem, localDue, loadState, SideDown, HOME } from './task-sync.mjs';

const BOARD = 'attilio-test01';
const ARMONIA = '🟡 Armonia';

// Inverso di localDue: «YYYY-MM-DD HH:MM» a Roma → ISO. Prova i due fusi possibili (ora legale e solare).
function fromLocal(s) {
  const [d, hm] = s.split(' ');
  for (const off of ['+02:00', '+01:00']) {
    const iso = new Date(`${d}T${hm}:00${off}`).toISOString();
    if (localDue(iso) === s) return iso;
  }
  throw new Error(`data locale impossibile: ${s}`);
}

function fakeTopics(initial = []) {
  const tasks = new Map(initial.map((t) => [t.id, { projectId: BOARD, status: 'backlog', ...t }]));
  const writes = [];
  const side = {
    tasks, writes, down: false, failDue: false,
    async read(board, linked) {
      if (side.down) throw new Error('connect ECONNREFUSED 127.0.0.1:3333');
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
      if ('status' in p) t.status = p.status;
      if ('text' in p) t.text = p.text;
      if ('dueDate' in p) t.dueDate = p.dueDate;
    },
    async approve(board, id) { writes.push(['approve', id]); tasks.get(id).status = 'done'; },
    async comment(board, id, c) { writes.push(['comment', id, c]); },
  };
  return side;
}

function fakeReminders(initial = []) {
  const items = new Map(initial.map((r) => [r.id, { listName: HOME, isCompleted: false, dueDate: null, notes: '', ...r }]));
  const writes = [];
  const side = {
    items, writes, down: false,
    read() {
      if (side.down) throw new Error('remindctl: accesso a Promemoria negato');
      return [...items.values()].map(normRem);
    },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-'));
  if (state) fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify(state));
  const topics = fakeTopics(cards), reminders = fakeReminders(rems);
  const journal = [], notified = [];
  const go = (extra = {}) => round({ topics, reminders, dir, board: BOARD, log: () => {}, journal: (e) => journal.push(...e), notify: (r) => notified.push(...r), ...extra });
  return { dir, topics, reminders, journal, notified, go, state: () => loadState(dir) };
}

const cardsOn = (t) => [...t.tasks.values()].filter((c) => c.projectId === BOARD);
const remsIn = (r, list = HOME) => [...r.items.values()].filter((x) => x.listName === list);

// ── Promemoria → Topics ──────────────────────────────────────────────────────

test('una voce nuova in Promemoria diventa una card in un giro, col simbolo tradotto in stato', async () => {
  const s = setup({ rems: [
    { id: 'R1AAAAAA-0000', title: '⚠ SON: sollecito da approvare', dueDate: '2026-10-30T09:00:00Z' },
    { id: 'R2BBBBBB-0000', title: 'Pagare l\'acqua', listName: ARMONIA },
    { id: 'R3CCCCCC-0000', title: 'già fatto', isCompleted: true },
  ] });
  await s.go();
  const cards = cardsOn(s.topics);
  assert.equal(cards.length, 2, 'una card per voce aperta, nessuna per quella completata');
  const son = cards.find((c) => c.text === 'SON: sollecito da approvare');
  assert.ok(son, 'il simbolo non entra nel titolo della card');
  assert.equal(son.status, 'review', '⚠ = aspetta Attilio = review');
  assert.equal(son.dueDate, '2026-10-30T09:00:00.000Z', 'la scadenza passa');
  assert.match(son.description, /^Da Promemoria «Jarvis\/ActiveTasks» · R1AAAAAA/);
  assert.equal(cards.find((c) => c.text === 'Pagare l\'acqua').status, 'backlog');
  assert.equal(s.reminders.writes.length, 0, 'il giro non tocca Promemoria');
  // Secondo giro: niente doppioni, niente scritture.
  s.topics.writes.length = 0;
  await s.go();
  assert.equal(cardsOn(s.topics).length, 2);
  assert.deepEqual(s.topics.writes, []);
  assert.deepEqual(s.reminders.writes, []);
});

test('una voce chiusa sul telefono chiude la card al giro dopo', async () => {
  const s = setup({ rems: [{ id: 'R1AAAAAA-0000', title: '► Patto Armonia' }] });
  await s.go();
  const [card] = cardsOn(s.topics);
  assert.equal(card.status, 'in_progress', '► = in corso');
  s.reminders.items.get('R1AAAAAA-0000').isCompleted = true;
  await s.go();
  assert.equal(card.status, 'done');
  // Riaperta sul telefono: torna aperta, nello stato del simbolo.
  s.reminders.items.get('R1AAAAAA-0000').isCompleted = false;
  await s.go();
  assert.equal(card.status, 'in_progress');
});

test('il simbolo cambiato da Jarvis sposta la card, senza avvisare Attilio', async () => {
  const s = setup({ rems: [{ id: 'R1AAAAAA-0000', title: '► PMI giro 6' }] });
  await s.go(); await s.go();
  s.reminders.items.get('R1AAAAAA-0000').title = '⚠ PMI giro 6';
  await s.go();
  assert.equal(cardsOn(s.topics)[0].status, 'review');
  assert.deepEqual(s.notified, [], 'il ⚠ lo ha già detto Jarvis nel suo turno');
});

// ── Topics → Promemoria ──────────────────────────────────────────────────────

test('una card nuova su Topics diventa una voce in Jarvis/ActiveTasks in un giro', async () => {
  const s = setup({ cards: [
    { id: randomUUID(), text: '[Hub] Tray v5: il tuo ok a vista', status: 'review', descriptionPreview: 'guarda il menu' },
    { id: randomUUID(), text: '[Quadra] Cron delle norme', status: 'backlog', dueDate: '2026-11-02T08:00:00.000Z' },
    { id: randomUUID(), text: 'già chiusa', status: 'done' },
    { id: randomUUID(), text: 'lavoro di un agente su un altro progetto', status: 'backlog', projectId: 'quadra-x' },
  ] });
  await s.go();
  const rems = remsIn(s.reminders);
  assert.deepEqual(rems.map((r) => r.title).sort(), ['[Quadra] Cron delle norme', '⚠ [Hub] Tray v5: il tuo ok a vista'].sort());
  assert.equal(rems.find((r) => r.title.startsWith('[Quadra]')).dueDate, '2026-11-02T08:00:00.000Z');
  assert.match(rems.find((r) => r.title.startsWith('⚠')).notes, /^guarda il menu · Topics [0-9a-f]{8}$/, 'una riga sola: todo-recap la stampa come ↳');
  assert.equal(s.topics.writes.length, 0, 'il giro non tocca Topics');
  s.reminders.writes.length = 0;
  await s.go();
  assert.equal(remsIn(s.reminders).length, 2, 'niente doppioni al secondo giro');
  assert.deepEqual(s.reminders.writes, []);
  assert.deepEqual(s.topics.writes, []);
});

test('una card chiusa su Topics chiude la voce al giro dopo', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Sito armonia.io finito', status: 'in_progress' }] });
  await s.go();
  const [rem] = remsIn(s.reminders);
  assert.equal(rem.title, '► Sito armonia.io finito');
  s.topics.tasks.get(id).status = 'done';
  await s.go();
  assert.equal(rem.isCompleted, true);
  s.topics.tasks.get(id).status = 'review';
  await s.go();
  assert.equal(rem.isCompleted, false, 'riaperta su Topics, riaperta sul telefono');
  assert.equal(rem.title, '⚠ Sito armonia.io finito');
  assert.equal(s.notified.length, 1, 'arrivata in review dal lato Topics: si avvisa Attilio');
});

test('una card in review su un\'altra board va sul telefono come ⚠; completarla la approva', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Model dropdown: routing ON', status: 'review', projectId: 'topics-app-x' }], state: { version: 1, links: {} } });
  await s.go();
  const [rem] = remsIn(s.reminders);
  assert.equal(rem.title, '⚠ Model dropdown: routing ON');
  assert.equal(s.notified.length, 1, 'non è il primo giro: la review nuova si dice');
  rem.isCompleted = true;
  await s.go();
  assert.deepEqual(s.topics.writes.filter((w) => w[0] === 'approve'), [['approve', id]]);
  assert.equal(s.topics.tasks.get(id).status, 'done');
});

test('il primo giro non manda avvisi: sarebbe tutto l\'arretrato', async () => {
  const s = setup({ cards: [{ id: randomUUID(), text: 'già in review', status: 'review' }] });
  await s.go();
  assert.deepEqual(s.notified, []);
});

// ── Conflitti, date, doppioni ────────────────────────────────────────────────

test('se cambiano entrambi i lati vince Topics', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Titolo A', status: 'backlog' }] });
  await s.go();
  const [rem] = remsIn(s.reminders);
  s.topics.tasks.get(id).text = 'Titolo da Topics';
  rem.title = 'Titolo dal telefono';
  await s.go();
  assert.equal(s.topics.tasks.get(id).text, 'Titolo da Topics');
  assert.equal(rem.title, 'Titolo da Topics');
});

test('stato cambiato dai due lati nello stesso giro: vince Topics', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Doppio cambio', status: 'backlog' }] });
  await s.go();
  const [rem] = remsIn(s.reminders);
  s.topics.tasks.get(id).status = 'review';
  rem.isCompleted = true;
  await s.go();
  assert.equal(s.topics.tasks.get(id).status, 'review');
  assert.equal(rem.isCompleted, false);
  assert.equal(rem.title, '⚠ Doppio cambio');
});

test('la scadenza si allinea nei due versi e si può togliere', async () => {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Con data', status: 'backlog' }] });
  await s.go();
  const [rem] = remsIn(s.reminders);
  rem.dueDate = '2026-10-31T10:30:00Z';
  await s.go();
  assert.equal(s.topics.tasks.get(id).dueDate, '2026-10-31T10:30:00.000Z');
  s.topics.tasks.get(id).dueDate = '2026-11-05T07:00:00.000Z';
  await s.go();
  assert.equal(rem.dueDate, '2026-11-05T07:00:00.000Z');
  s.topics.tasks.get(id).dueDate = null;
  await s.go();
  assert.equal(rem.dueDate, null);
});

test('una card e una voce con lo stesso titolo si collegano invece di duplicarsi', async () => {
  const s = setup({ cards: [{ id: randomUUID(), text: 'Controllo risposta ITS', status: 'backlog' }], rems: [{ id: 'R9ZZZZZZ-0000', title: '☐ Controllo risposta ITS' }] });
  await s.go(); await s.go();
  assert.equal(cardsOn(s.topics).length, 1);
  assert.equal(remsIn(s.reminders).length, 1);
  assert.equal(remsIn(s.reminders)[0].title, '☐ Controllo risposta ITS', 'il ☐ di scadenze-sync resta');
});

test('una card creata a metà (data non salvata) non nasce due volte', async () => {
  const s = setup({ rems: [{ id: 'R1AAAAAA-0000', title: 'Con data', dueDate: '2026-10-30T09:00:00Z' }] });
  s.topics.failDue = true;
  await s.go();
  s.topics.failDue = false;
  await s.go(); await s.go();
  const cards = cardsOn(s.topics);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dueDate, '2026-10-30T09:00:00.000Z', 'la data arriva al giro dopo');
  assert.equal(s.reminders.items.get('R1AAAAAA-0000').dueDate, '2026-10-30T09:00:00Z', 'e la voce tiene la sua');
});

// ── Un lato giù ──────────────────────────────────────────────────────────────

async function sideDownCase(which) {
  const id = randomUUID();
  const s = setup({ cards: [{ id, text: 'Card collegata', status: 'backlog' }], rems: [{ id: 'R1AAAAAA-0000', title: 'Voce collegata' }] });
  await s.go();
  const before = fs.readFileSync(path.join(s.dir, 'links.json'), 'utf8');
  const nCards = s.topics.tasks.size, nRems = s.reminders.items.size;
  s.topics.writes.length = 0; s.reminders.writes.length = 0;
  // Nel frattempo l'altro lato cambia: niente deve uscire finché il primo è giù.
  s.topics.tasks.get(id).status = 'done';
  s.reminders.items.get('R1AAAAAA-0000').isCompleted = true;
  s[which].down = true;
  await assert.rejects(s.go(), SideDown);
  assert.deepEqual(s.topics.writes, [], 'nessuna scrittura su Topics');
  assert.deepEqual(s.reminders.writes, [], 'nessuna scrittura su Promemoria');
  assert.equal(s.topics.tasks.size, nCards);
  assert.equal(s.reminders.items.size, nRems);
  assert.equal(fs.readFileSync(path.join(s.dir, 'links.json'), 'utf8'), before, 'lo stato non cambia');
  assert.ok(s.journal.some((e) => e.kind === 'giro saltato'), 'il giro lo dice nel diario');
  s[which].down = false;
  await s.go();
  return s;
}

test('Topics giù: il giro esce senza scrivere niente e poi riprende', async () => {
  const s = await sideDownCase('topics');
  assert.equal(remsIn(s.reminders).every((r) => r.isCompleted), true);
});

test('Promemoria giù: il giro esce senza scrivere niente e poi riprende', async () => {
  const s = await sideDownCase('reminders');
  assert.equal(cardsOn(s.topics).every((c) => c.status === 'done'), true);
});

test('molte voci sparite insieme = lato guasto: nessuna card chiusa', async () => {
  const s = setup({ rems: [1, 2, 3, 4].map((n) => ({ id: `R${n}AAAAAA-0000`, title: `Voce ${n}` })) });
  await s.go();
  s.reminders.items.clear();
  s.topics.writes.length = 0;
  await assert.rejects(s.go(), SideDown);
  assert.deepEqual(s.topics.writes, []);
  assert.equal(cardsOn(s.topics).every((c) => c.status === 'backlog'), true);
});

test('una voce sola cancellata dal telefono chiude la sua card, senza cancellarla', async () => {
  const s = setup({ rems: [1, 2, 3, 4].map((n) => ({ id: `R${n}AAAAAA-0000`, title: `Voce ${n}` })) });
  await s.go();
  s.reminders.items.delete('R2AAAAAA-0000');
  await s.go();
  const cards = cardsOn(s.topics);
  assert.equal(cards.length, 4, 'nessuna card sparisce');
  assert.equal(cards.find((c) => c.text === 'Voce 2').status, 'done');
  assert.equal(cards.filter((c) => c.status === 'done').length, 1);
  await s.go();
  assert.equal(remsIn(s.reminders).length, 3, 'la voce cancellata non viene ricreata');
});
