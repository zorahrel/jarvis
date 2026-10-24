#!/usr/bin/env node
// task-sync: la board Topics è la fonte unica dei task (Attilio, 24/10); Promemoria Apple ne tiene una copia per il telefono.
//
// Un giro legge i due lati, confronta ciascuno con l'ultimo stato concordato (state/task-sync/links.json) e porta
// dall'altra parte ciò che è cambiato, campo per campo: titolo, stato, scadenza. Se cambiano entrambi vince Topics.
//
// Cosa entra:
//   · Promemoria: le voci aperte delle liste LISTS (Jarvis/ActiveTasks, dove scrivono Jarvis e scadenze-sync,
//     e 🟡 Armonia) diventano card sulla board BOARD.
//   · Topics: le card aperte di BOARD e quelle in review su qualunque altra board diventano voci in Jarvis/ActiveTasks.
// Stato ↔ simbolo, solo in Jarvis/ActiveTasks (convenzione di OPS-ATTILIO.md): ⚠ = review (aspetta Attilio),
// ► = in_progress, ☐ ■ o niente = backlog; voce completata = done. Nelle altre liste conta solo aperto/chiuso.
//
// Mai una cancellazione: chiudere è completare. Se un lato non risponde il giro non scrive niente ed esce 2.
//   task-sync.mjs [--dry-run]
// Ambiente: TASK_SYNC_WA (numero WhatsApp a cui dire cosa è arrivato in review), TASK_SYNC_STATE, TOPICS_URL, TOPICS_CA.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { diario } from './diario.mjs';

export const BOARD = process.env.TASK_SYNC_BOARD || 'attilio-mn52yh';
export const HOME = 'Jarvis/ActiveTasks';
export const LISTS = [HOME, '🟡 Armonia'];
const SYMS = ['⚠', '►', '☐', '■'];
const CRON = /Cron ([0-9a-f]{8}) · scadenza/; // la nota che scadenze-sync mette ai suoi ☐
// Oltre questa soglia di voci collegate sparite in un colpo solo, il lato è guasto, non svuotato da Attilio.
const VANISH_MIN = 3;

// ── Normalizzazione ─────────────────────────────────────────────────────────

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function splitSym(title) {
  const t = clean(title);
  const sym = SYMS.find((s) => t.startsWith(s));
  return sym ? { sym, name: clean(t.slice(sym.length)) } : { sym: '', name: t };
}

// Al minuto, in UTC: remindctl e Topics scrivono la stessa data con secondi e millisecondi diversi.
export function minuteIso(v) {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 16) + 'Z';
}

// Data locale «YYYY-MM-DD HH:MM» (Europe/Rome), quella che remindctl prende per --due.
export function localDue(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Classe di stato condivisa dai due lati: open | in_progress | review | done.
export function cardCls(t) {
  if (t.archived || t.status === 'done') return 'done';
  if (t.status === 'review' || t.status === 'in_progress') return t.status;
  return 'open';
}

export function normCard(t) {
  return { id: t.id, board: t.projectId, title: clean(t.text), status: t.status, cls: cardCls(t), due: minuteIso(t.dueDate), text: t.descriptionPreview || t.description || '' };
}

export function normRem(r) {
  // Il simbolo si toglie sempre dal nome (una voce spostata fuori da Jarvis/ActiveTasks lo porta con sé),
  // ma dice lo stato solo in Jarvis/ActiveTasks.
  const home = r.listName === HOME;
  const { sym, name } = splitSym(r.title);
  const cls = r.isCompleted ? 'done' : !home ? 'open' : sym === '⚠' ? 'review' : sym === '►' ? 'in_progress' : 'open';
  return { id: r.id, list: r.listName, home, sym, name, raw: r.title, done: !!r.isCompleted, cls, due: minuteIso(r.dueDate), notes: r.notes || '' };
}

// Nota di una voce nata su Topics: UNA riga corta (convenzione di OPS-ATTILIO.md: todo-recap la stampa come «↳ …»
// nei WhatsApp di Jarvis), con la prima frase della descrizione e il marcatore del collegamento.
export function noteFor(c, board = BOARD) {
  const s = clean(c.text).split(/(?<=[.!?])\s/)[0] || '';
  const first = s.length > 110 ? s.slice(0, 109).replace(/\s\S*$/, '') + '…' : s;
  const where = c.board === board ? '' : ` · ${c.board.replace(/-[a-z0-9]{6}$/, '')}`;
  return `${first ? `${first} · ` : ''}Topics ${c.id.slice(0, 8)}${where}`;
}

const symFor = (cls, cur) => (cls === 'review' ? '⚠' : cls === 'in_progress' ? '►' : cur === '☐' || cur === '■' ? cur : '');
const remTitle = (r, sym, name) => (r.home && sym ? `${sym} ${name}` : name);
// Ciò che una lista sa dire dello stato: Jarvis/ActiveTasks tutto, le altre solo aperto/chiuso.
const projR = (home, cls) => (home ? cls : cls === 'done' ? 'done' : 'open');
const statusFor = (cls, cur) => (cls === 'open' ? (cur === 'todo' ? 'todo' : 'backlog') : cls);

// ── Il punto critico: cosa scrivere, da che parte ────────────────────────────
// Pura: riceve ciò che i lati hanno risposto e lo stato concordato, restituisce gruppi di operazioni.
// Ogni gruppo riguarda una coppia; il chiamante aggiorna il collegamento solo se tutte le sue operazioni riescono.

export class SideDown extends Error {}

export function plan({ cards, missing = new Set(), reminders, state, board = BOARD }) {
  const links = state.links || {};
  const byCard = new Map(cards.map((c) => [c.id, c]));
  const byRem = new Map(reminders.map((r) => [r.id, r]));
  const linkedR = new Set(Object.values(links).map((l) => l.rid));
  const linkedC = new Set(Object.keys(links));
  const groups = [];

  // Guardia: un lato che «perde» molte voci insieme è un lato guasto. Anche lista per lista: una lista che per un guasto
  // risponde vuota chiuderebbe tutte le sue card restando sotto la soglia di tutto l'insieme.
  const live = Object.entries(links).filter(([, l]) => !l.gone);
  const goneR = live.filter(([, l]) => !byRem.has(l.rid)).length;
  const goneC = live.filter(([cid]) => missing.has(cid)).length;
  if (goneR >= VANISH_MIN && goneR * 2 > live.length) throw new SideDown(`Promemoria: ${goneR} voci collegate sparite in un giro, non tocco niente`);
  if (goneC >= VANISH_MIN && goneC * 2 > live.length) throw new SideDown(`Topics: ${goneC} card collegate sparite in un giro, non tocco niente`);
  const perList = new Map();
  for (const [, l] of live) {
    const k = l.list || HOME, p = perList.get(k) || { all: 0, gone: 0 };
    p.all++; if (!byRem.has(l.rid)) p.gone++;
    perList.set(k, p);
  }
  for (const [k, p] of perList) if (p.gone >= VANISH_MIN && p.gone * 2 > p.all) throw new SideDown(`Promemoria «${k}»: ${p.gone} voci collegate sparite in un giro, non tocco niente`);

  for (const [cid, link] of live) {
    const c = byCard.get(cid), r = byRem.get(link.rid);
    if (!c && !missing.has(cid)) continue; // non letta in questo giro: si riprova al prossimo
    if (!c) {
      groups.push({
        cid, link: { ...link, gone: 'topics' },
        ops: r && !r.done ? [{ op: 'rem.edit', rid: r.id, args: { complete: true }, what: r.raw }] : [],
        events: [{ kind: 'sparita', text: `card sparita da Topics${r && !r.done ? ', promemoria chiuso' : ''}: ${r?.name ?? link.base.title}`, ref: cid }],
      });
      continue;
    }
    if (!r) {
      // Cancellata dal telefono: la card si chiude (si riapre), non si cancella.
      groups.push({
        cid, link: { ...link, gone: 'promemoria' }, refused: { ...link, gone: 'promemoria' },
        ops: c.cls !== 'done' ? [{ op: 'card.patch', cid, board: c.board, patch: { status: 'done' }, comment: 'Chiusa perché il promemoria collegato è stato cancellato dal telefono.', what: c.title }] : [],
        events: [{ kind: 'sparita', text: `promemoria cancellato${c.cls !== 'done' ? ', card chiusa' : ''}: ${c.title}`, ref: cid }],
      });
      continue;
    }
    const g = reconcile(c, r, link, board);
    if (g) groups.push(g);
  }

  // Voci nuove in Promemoria → card su BOARD (o collegamento a una card che c'è già).
  for (const r of reminders) {
    if (r.done || linkedR.has(r.id) || !LISTS.includes(r.list)) continue;
    const cron = CRON.exec(r.notes)?.[1];
    // Un ☐ cancellato dal telefono lo rimette scadenze-sync finché il job vive: torna alla SUA card, non a una nuova.
    const prev = cron && Object.entries(links).find(([, l]) => l.cron === cron && l.rid !== r.id);
    if (prev) {
      const [pcid, { gone, ...pl }] = prev;
      linkedR.add(r.id);
      groups.push({ cid: pcid, link: { ...pl, rid: r.id, list: r.list, base: { title: r.name, cls: r.cls, due: r.due } }, ops: [],
        events: [{ kind: 'collegata', text: `☐ rimesso da scadenze-sync, torna alla sua card: ${r.name}`, ref: pcid }] });
      continue;
    }
    // Il marcatore «Topics <id8>» la scrive questo sync: vale su qualunque board. Il titolo e il marcatore inverso solo su BOARD.
    const marker = /Topics ([0-9a-f]{8})/.exec(r.notes)?.[1];
    const twin = (marker && cards.find((c) => !linkedC.has(c.id) && c.id.startsWith(marker)))
      || cards.find((c) => !linkedC.has(c.id) && c.board === board && c.cls !== 'done' && (c.title === r.name || c.text.includes(`· ${r.id.slice(0, 8)}`)));
    if (twin) {
      linkedR.add(r.id); linkedC.add(twin.id);
      // Base = la voce, così al giro di confronto vince la card (Topics è la fonte).
      const link = { rid: r.id, list: r.list, scope: twin.board === board ? 'board' : 'review', ...(cron ? { cron } : {}), base: { title: r.name, cls: r.cls, due: r.due } };
      groups.push({ cid: twin.id, link, ops: [], events: [{ kind: 'collegata', text: `già su Topics, collegata: ${r.name}`, ref: twin.id }] });
      continue;
    }
    linkedR.add(r.id);
    // Il marcatore va in testa: l'anteprima della descrizione che Topics restituisce è tagliata.
    const description = [`Da Promemoria «${r.list}» · ${r.id.slice(0, 8)}`, r.notes.trim()].filter(Boolean).join('\n\n');
    groups.push({
      cid: null,
      link: { rid: r.id, list: r.list, scope: 'board', ...(cron ? { cron } : {}), base: { title: r.name, cls: r.cls, due: r.due } },
      ops: [{ op: 'card.create', board, task: { text: r.name, description, status: statusFor(r.cls, 'backlog') }, due: r.due, what: r.name }],
      events: [{ kind: 'nuova', text: `da Promemoria su Topics: ${r.name}`, ref: r.id }],
    });
  }

  // Card nuove su Topics → voce in Jarvis/ActiveTasks.
  const freeRems = reminders.filter((r) => !linkedR.has(r.id) && r.home && !r.done);
  for (const c of cards) {
    if (linkedC.has(c.id) || c.cls === 'done') continue;
    const scope = c.board === board ? 'board' : c.cls === 'review' ? 'review' : null;
    if (!scope) continue;
    const marker = /Promemoria «[^»]*» · ([0-9A-F]{8})/.exec(c.text)?.[1];
    const twin = freeRems.find((r) => (marker && r.id.startsWith(marker)) || r.notes.includes(`Topics ${c.id.slice(0, 8)}`) || r.name === c.title);
    const sym = symFor(c.cls, twin?.sym ?? '');
    if (twin) {
      freeRems.splice(freeRems.indexOf(twin), 1);
      linkedC.add(c.id); linkedR.add(twin.id);
      const link = { rid: twin.id, list: twin.list, scope, base: { title: twin.name, cls: twin.cls, due: twin.due } };
      const g = reconcile(c, twin, link, board);
      groups.push(g ? { ...g, events: [{ kind: 'collegata', text: `già in Promemoria, collegata: ${c.title}`, ref: c.id }, ...g.events] }
        : { cid: c.id, link, ops: [], events: [{ kind: 'collegata', text: `già in Promemoria, collegata: ${c.title}`, ref: c.id }] });
      continue;
    }
    linkedC.add(c.id);
    const notes = noteFor(c, board);
    groups.push({
      cid: c.id,
      link: { rid: null, list: HOME, scope, base: { title: c.title, cls: c.cls, due: c.due } },
      ops: [{ op: 'rem.create', list: HOME, title: sym ? `${sym} ${c.title}` : c.title, due: c.due, notes, what: c.title }],
      events: [{ kind: 'nuova', text: `da Topics in Promemoria: ${c.title}`, ref: c.id }],
      review: c.cls === 'review' ? c : null,
    });
  }
  return groups;
}

// Una coppia collegata: fusione a tre vie per campo contro la base concordata. Null se non c'è niente da fare.
export function reconcile(c, r, link, board = BOARD) {
  const base = link.base;
  // Una card di un'altra board entrata come «review» che arriva su BOARD diventa una card piena.
  const scope = link.scope === 'review' && c.board === board ? 'board' : link.scope;
  const ops = [], events = [];
  let review = null;

  // Titolo
  const title = c.title !== base.title ? c.title : r.name !== base.title ? r.name : base.title;

  // Stato
  let cls;
  if (scope === 'review') {
    // Copia di una card di progetto: aperta finché la card aspetta Attilio. Dal telefono vale solo «chiudi» = approva.
    const remClosedNow = r.done && base.cls === 'review' && c.cls === 'review';
    cls = remClosedNow ? 'done' : c.cls;
    if (remClosedNow) ops.push({ op: 'card.approve', cid: c.id, board: c.board, comment: 'Approvata da Promemoria (voce completata sul telefono).', what: c.title });
    const wantOpen = cls === 'review';
    if (wantOpen && (r.done || (r.home && r.sym !== '⚠') || r.name !== title)) ops.push({ op: 'rem.edit', rid: r.id, args: { ...(r.done ? { incomplete: true } : {}), title: remTitle(r, '⚠', title) }, what: title });
    else if (!wantOpen && !r.done) ops.push({ op: 'rem.edit', rid: r.id, args: { complete: true, ...(r.name !== title ? { title: remTitle(r, r.sym, title) } : {}) }, what: title });
    if (c.cls === 'review' && base.cls !== 'review') review = c;
  } else {
    const cardChanged = c.cls !== base.cls;
    const remChanged = projR(r.home, r.cls) !== projR(r.home, base.cls);
    cls = cardChanged ? c.cls : remChanged ? r.cls : base.cls;
    if (c.cls !== cls) ops.push({ op: 'card.patch', cid: c.id, board: c.board, patch: { status: statusFor(cls, c.status) }, what: title });
    const sym = r.home ? symFor(cls, r.sym) : '';
    const wantTitle = remTitle(r, sym, title);
    const args = {};
    if (cls === 'done' && !r.done) args.complete = true;
    if (cls !== 'done' && r.done) args.incomplete = true;
    if (cls !== 'done' && clean(r.raw) !== wantTitle) args.title = wantTitle;
    if (cls === 'done' && r.name !== title) args.title = remTitle(r, r.sym, title);
    if (Object.keys(args).length) ops.push({ op: 'rem.edit', rid: r.id, args, what: title });
    if (cardChanged && c.cls === 'review') review = c;
  }

  // Titolo sulla card (lo stato l'ha già messo sopra)
  if (c.title !== title) {
    const p = ops.find((o) => o.op === 'card.patch');
    if (p) p.patch.text = title;
    else ops.push({ op: 'card.patch', cid: c.id, board: c.board, patch: { text: title }, what: title });
  }

  // Scadenza
  const due = c.due !== base.due ? c.due : r.due !== base.due ? r.due : base.due;
  if (c.due !== due) {
    const p = ops.find((o) => o.op === 'card.patch');
    if (p) p.patch.dueDate = due ? new Date(due).toISOString() : null;
    else ops.push({ op: 'card.patch', cid: c.id, board: c.board, patch: { dueDate: due ? new Date(due).toISOString() : null }, what: title });
  }
  if (r.due !== due) {
    const e = ops.find((o) => o.op === 'rem.edit');
    const extra = due ? { due: localDue(due) } : { clearDue: true };
    if (e) Object.assign(e.args, extra);
    else ops.push({ op: 'rem.edit', rid: r.id, args: extra, what: title });
  }

  const cron = CRON.exec(r.notes)?.[1] ?? link.cron;
  const next = { ...link, list: r.list, ...(cron ? { cron } : {}), scope, base: { title, cls, due } };
  const same = JSON.stringify(next) === JSON.stringify(link);
  if (!ops.length && same) return null;
  for (const o of ops) events.push({ kind: describe(o), text: `${describe(o)}: ${o.what}`, ref: c.id });
  // Se Topics rifiuta la scrittura (check rossi, sottotask aperti…) non si riprova a ogni giro: la base diventa la voce,
  // così al giro dopo la card risulta «cambiata», vince, e il telefono torna com'è la card.
  const refused = { ...next, base: { title: r.name, cls: r.cls, due: r.due } };
  return { cid: c.id, link: next, ops, events, review, refused };
}

function describe(o) {
  if (o.op === 'card.approve') return 'approvata da Promemoria';
  if (o.op === 'card.patch') return o.patch.status === 'done' ? 'chiusa su Topics' : 'aggiornata su Topics';
  if (o.op === 'rem.edit') return o.args.complete ? 'chiusa in Promemoria' : o.args.incomplete ? 'riaperta in Promemoria' : 'aggiornata in Promemoria';
  return o.op;
}

// ── I due lati ───────────────────────────────────────────────────────────────

export function topicsSide({ base = process.env.TOPICS_URL || 'https://127.0.0.1:3333', caPath = process.env.TOPICS_CA || path.join(os.homedir(), 'Projects/topics-app/certs/ca-cert.pem'), token = '' } = {}) {
  let ca;
  try { ca = fs.readFileSync(caPath); } catch { ca = undefined; }
  const api = (method, p, body) => new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (url.protocol === 'http:' ? httpRequest : httpsRequest)({
      method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, ca, timeout: 15000,
      headers: { ...(token ? { 'x-agent-token': token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`Topics ${method} ${url.pathname}: ${res.statusCode} ${data.slice(0, 200)}`), { status: res.statusCode }));
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Topics ${url.pathname}: risposta non JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Topics ${url.pathname}: nessuna risposta in 15 s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const enc = encodeURIComponent;
  return {
    async read(board, linkedIds) {
      const [own, feed] = await Promise.all([api('GET', `/api/boards/${enc(board)}/tasks`), api('GET', '/api/all-boards/tasks')]);
      const seen = new Map();
      for (const t of own.tasks || []) seen.set(t.id, t);
      for (const t of feed.tasks || []) if (!seen.has(t.id) && t.status === 'review' && !t.archived && !t.parentTaskId) seen.set(t.id, t);
      // Le collegate che non sono in nessuna delle due liste (spostate, archiviate, done vecchie): una per una.
      const missing = new Set();
      for (const id of linkedIds) {
        if (seen.has(id)) continue;
        const { task } = await api('GET', `/api/all-boards/tasks/${enc(id)}`);
        if (task) seen.set(id, task); else missing.add(id);
      }
      return { cards: [...seen.values()].filter((t) => !t.parentTaskId || linkedIds.includes(t.id)).map(normCard), missing };
    },
    async create(board, { description, ...task }, due) {
      // Nasce SENZA descrizione: a una card nata con una descrizione più lunga del titolo Topics riscrive in sottofondo
      // il titolo (titoloMigliore), e «Patto Armonia: versione con riserva fissa…» diventava «Versione con riserva fissa
      // per Attilio», anche nei Promemoria. Descrizione e data (che la creazione ignora) arrivano subito dopo.
      const t = await api('POST', `/api/boards/${enc(board)}/tasks`, task);
      const patch = { ...(description ? { description } : {}), ...(due ? { dueDate: new Date(due).toISOString() } : {}) };
      if (!Object.keys(patch).length) return { id: t.id, dueSet: true };
      // Se la seconda chiamata fallisce la card esiste comunque: si restituisce l'id (sennò al giro dopo nascerebbe un
      // doppione) e la data la rimette il giro dopo.
      try { await api('PATCH', `/api/boards/${enc(board)}/tasks/${t.id}`, patch); return { id: t.id, dueSet: true }; }
      catch { return { id: t.id, dueSet: !due }; }
    },
    patch: (board, id, patch) => api('PATCH', `/api/boards/${enc(board)}/tasks/${id}`, patch),
    approve: (board, id, comment) => api('POST', `/api/boards/${enc(board)}/tasks/${id}/review`, { decision: 'approve', comment }),
    comment: (board, id, content) => api('POST', `/api/boards/${enc(board)}/tasks/${id}/comments`, { content, quiet: true }),
  };
}

export function remindersSide(bin = process.env.REMINDCTL || 'remindctl') {
  const rc = (args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const json = (args) => {
    const out = rc(args);
    try { return JSON.parse(out); } catch { throw new Error(`remindctl ${args[0]}: risposta non JSON`); }
  };
  return {
    // Tutte le liste: una voce spostata in un'altra lista si ritrova per id e il collegamento la segue.
    read() {
      const lists = json(['list', '--json']).map((l) => l.title);
      for (const l of LISTS) if (!lists.includes(l)) throw new Error(`Promemoria: manca la lista «${l}»`);
      return lists.flatMap((l) => {
        const out = json(['list', l, '--json']);
        if (Array.isArray(out)) return out;
        if (Array.isArray(out?.reminders)) return out.reminders;
        throw new Error(`remindctl list «${l}»: risposta senza elenco`);
      }).map(normRem);
    },
    create({ list, title, due, notes }) {
      const out = json(['add', '--title', title, '--list', list, ...(due ? ['--due', localDue(due)] : []), ...(notes ? ['--notes', notes] : []), '--no-input', '--json']);
      if (!out?.id) throw new Error('remindctl add: nessun id nella risposta');
      return out.id;
    },
    edit(id, a) {
      const args = ['edit', id];
      if (a.title) args.push('--title', a.title);
      if (a.due) args.push('--due', a.due);
      if (a.notes) args.push('--notes', a.notes);
      if (a.clearDue) args.push('--clear-due');
      if (a.complete) args.push('--complete');
      if (a.incomplete) args.push('--incomplete');
      args.push('--no-input', '--json');
      json(args);
    },
  };
}

// ── Stato ────────────────────────────────────────────────────────────────────

export const STATE_DIR = process.env.TASK_SYNC_STATE || path.join(os.homedir(), '.claude/jarvis/state/task-sync');
const statePath = (dir) => path.join(dir, 'links.json');

export function loadState(dir = STATE_DIR) {
  try { return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, links: {}, first: true };
    throw new Error(`stato illeggibile (${statePath(dir)}): ${e.message}. Non lo riscrivo da zero: creerebbe doppioni.`);
  }
}

export function saveState(state, dir = STATE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, statePath(dir));
}

// Due giri insieme creerebbero la stessa card due volte: uno alla volta. Un lucchetto più vecchio di 10 minuti è di un giro morto.
function lock(dir) {
  const p = path.join(dir, 'lock');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.mkdirSync(p); } catch {
    if (Date.now() - fs.statSync(p).mtimeMs < 600000) return null;
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p);
  }
  return () => fs.rmSync(p, { recursive: true, force: true });
}

// ── Un giro ──────────────────────────────────────────────────────────────────

export async function round({ topics, reminders, dir = STATE_DIR, board = BOARD, dry = false, notify = null, quiet = () => false, log = console.log, journal = diario }) {
  if (dry) journal = () => {};
  const state = loadState(dir);
  const first = !!state.first;
  const linkedIds = Object.entries(state.links).filter(([, l]) => !l.gone).map(([id]) => id);
  let cards, missing, rems;
  // Prima tutte le letture: se un lato non risponde non si scrive niente da nessuna parte.
  try {
    ({ cards, missing } = await topics.read(board, linkedIds));
    rems = await reminders.read();
  } catch (e) {
    const err = new SideDown(e.message);
    journal([{ kind: 'giro saltato', text: `un lato non risponde, niente scritto: ${e.message}` }]);
    throw err;
  }
  let groups;
  try { groups = plan({ cards, missing, reminders: rems, state, board }); } catch (e) {
    if (e instanceof SideDown) journal([{ kind: 'giro saltato', text: e.message }]);
    throw e;
  }

  const done = [], failed = [], reviews = [];
  for (const g of groups) {
    if (dry) { for (const e of g.events) log(`[prova] ${e.text}`); if (!g.ops.length) log(`[prova] collegamento: ${g.events[0]?.text ?? g.cid}`); continue; }
    try {
      let cid = g.cid, rid = g.link.rid, link = g.link;
      for (const o of g.ops) {
        if (o.op === 'card.create') {
          const made = await topics.create(o.board, o.task, o.due);
          cid = made.id;
          if (!made.dueSet) link = { ...link, base: { ...link.base, due: null } };
        }
        else if (o.op === 'card.patch') { await topics.patch(o.board, o.cid, o.patch); if (o.comment) await topics.comment(o.board, o.cid, o.comment); }
        else if (o.op === 'card.approve') await topics.approve(o.board, o.cid, o.comment);
        else if (o.op === 'rem.create') rid = await reminders.create(o);
        else if (o.op === 'rem.edit') await reminders.edit(o.rid, o.args);
      }
      state.links[cid] = { ...link, rid };
      done.push(...g.events.map((e) => ({ ...e, ref: e.ref ?? cid })));
      if (g.review) reviews.push(g.review);
    } catch (e) {
      if (e.status >= 400 && e.status < 500 && g.refused && g.cid) {
        state.links[g.cid] = g.refused;
        failed.push({ kind: 'errore', text: `Topics rifiuta (${g.events[0]?.text ?? g.cid}), il telefono torna com'è la card: ${e.message}`, ref: g.cid });
      } else failed.push({ kind: 'errore', text: `${g.events[0]?.text ?? g.cid}: ${e.message}`, ref: g.cid });
    }
  }
  if (dry) return { groups, failed, reviews };
  // Ad Attilio solo ciò che è arrivato in review dal lato Topics, e mai al primo giro (sarebbe tutto l'arretrato).
  // Nelle ore silenziose si tiene nello stato e parte tutto insieme al primo giro sveglio.
  let send = [];
  if (notify && !first) {
    const pending = [...(state.pendingReviews || [])];
    for (const r of reviews) if (!pending.some((p) => p.id === r.id)) pending.push(r);
    if (pending.length && quiet()) state.pendingReviews = pending;
    else { send = pending; delete state.pendingReviews; }
  }
  delete state.first;
  state.lastRound = new Date().toISOString();
  saveState(state, dir);
  journal([...done, ...failed]);
  for (const e of [...done, ...failed]) log(e.text);
  if (send.length) notify(send);
  return { groups, failed, reviews };
}

// Ore silenziose come lavori-watch: 23-8, ma solo a Mac fermo da 30 minuti (Attilio al Mac è sveglio).
export function isQuiet(now = Date.now(), idleS = macIdleS()) {
  const h = new Date(now).getHours();
  return (h >= 23 || h < 8) && (idleS == null || idleS >= 1800);
}

function macIdleS() {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/"HIDIdleTime" = (\d+)/);
    return m ? Number(m[1]) / 1e9 : null;
  } catch { return null; }
}

function whatsapp(target) {
  return (reviews) => {
    const text = `🔎 Aspetta te su Topics: ${reviews.length}\n${reviews.map((c) => `· ${c.title}`).join('\n')}`;
    try { execFileSync('openclaw', ['message', 'send', '--channel', 'whatsapp', '--target', target, '-m', text], { stdio: 'ignore', timeout: 60000 }); }
    catch (e) { diario([{ kind: 'errore', text: `avviso WhatsApp non partito: ${e.message}` }]); }
  };
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const release = dry ? () => {} : lock(STATE_DIR);
  if (!release) { console.log('un altro giro è in corso, salto'); return; }
  let token = '';
  try { token = execFileSync('security', ['find-generic-password', '-s', 'topics', '-a', 'agent-token', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  try {
    const { failed } = await round({ topics: topicsSide({ token }), reminders: remindersSide(), dry, notify: process.env.TASK_SYNC_WA ? whatsapp(process.env.TASK_SYNC_WA) : null, quiet: () => isQuiet() });
    if (failed.length) process.exitCode = 1;
  } catch (e) {
    console.error(`task-sync: ${e.message}`);
    process.exitCode = e instanceof SideDown ? 2 : 1;
  } finally { release(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
