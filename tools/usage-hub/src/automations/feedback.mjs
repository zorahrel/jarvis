// Giudizio di Attilio sulle automazioni: righe JSONL append-only, mai riscritte.
// Lo stato vive solo in memoria, ricostruito rileggendo tutte le righe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operatore } from '../operatore.mjs';

export function feedbackDir() {
  return process.env.USAGE_HUB_FEEDBACK_DIR
    || path.join(os.homedir(), '.claude', 'jarvis', 'private', 'automazioni', 'feedback');
}

const KINDS = ['vote', 'note', 'complaint', 'mute', 'migration', 'fix', 'resolve', 'undo'];
const VOTES = ['ok', 'cambia', 'indietro'];
const CONTENT = new Set(['vote', 'note', 'complaint', 'mute', 'fix']);

// Il problema della riga in italiano, o null se va bene.
export function validate(row) {
  if (!row || typeof row !== 'object') return 'riga vuota';
  if (!KINDS.includes(row.kind)) return `kind sconosciuto: ${row.kind}`;
  if (row.kind === 'resolve' || row.kind === 'undo') {
    if (!row.ref) return `manca ref per ${row.kind}`;
    return null;
  }
  // la migration vale per la chiave vecchia: key non serve
  if (row.kind === 'migration') return !row.from || !row.to ? 'mancano from o to per migration' : null;
  if (!row.key) return `manca key per ${row.kind}`;
  switch (row.kind) {
    case 'vote':
      if (!VOTES.includes(row.v)) return `voto non valido: ${row.v}`;
      if (row.v === 'cambia' && !row.note) return 'manca note per il voto cambia';
      return null;
    case 'note':
    case 'complaint':
      if (!row.note) return `manca note per ${row.kind}`;
      return null;
    case 'mute':
      if (!row.why) return 'manca why per mute';
      if (row.until === undefined) return 'manca until per mute (null = per sempre)';
      if (row.until !== null && Number.isNaN(Date.parse(row.until))) return 'until non è una data';
      return null;
    case 'fix':
      if (!row.why) return 'manca why per fix';
      return null;
    default:
      return null;
  }
}

function rid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

function monthFile(dir, at) {
  const d = new Date(at);
  const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return path.join(dir, `${m}.jsonl`);
}

// Aggiunge una riga al file del mese, senza toccare le altre.
export function append(row, { dir } = {}) {
  const full = { ...row };
  if (!full.id) full.id = rid();
  if (!full.at) full.at = new Date().toISOString();
  if (!full.by) full.by = operatore();
  if (!full.src) full.src = 'hub';
  if (full.kind === 'mute' && full.until === undefined) full.until = null;
  const err = validate(full);
  if (err) throw new Error(err);
  const d = dir || feedbackDir();
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(monthFile(d, full.at), `${JSON.stringify(full)}\n`);
  return full;
}

// Tutte le righe di tutti i mensili, in ordine di file e di riga.
export function readAll({ dir } = {}) {
  const d = dir || feedbackDir();
  let names;
  try {
    names = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return { rows: [], bad: 0 };
  }
  const rows = [];
  let bad = 0;
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(d, n), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        bad += 1;
      }
    }
  }
  return { rows, bad };
}

// Segue la catena di migration fino alla chiave finale, senza girare in tondo.
function resolveKey(key, jumps) {
  let k = key;
  const seen = new Set([k]);
  while (jumps.has(k)) {
    k = jumps.get(k);
    if (seen.has(k)) break;
    seen.add(k);
  }
  return k;
}

// Ricostruisce lo stato per chiave, senza scrivere niente.
export function buildState(rows, { now = Date.now() } = {}) {
  const undone = new Set();
  for (const r of rows) if (r.kind === 'undo' && r.ref) undone.add(r.ref);
  const live = rows.filter((r) => !undone.has(r.id) && r.kind !== 'undo');
  const jumps = new Map();
  for (const r of live) if (r.kind === 'migration' && r.from && r.to) jumps.set(r.from, r.to);
  const closed = new Set();
  for (const r of live) if (r.kind === 'resolve' && r.ref) closed.add(r.ref);
  const groups = new Map();
  for (const r of live) {
    if (!CONTENT.has(r.kind) || !r.key) continue;
    const fk = resolveKey(r.key, jumps);
    if (!groups.has(fk)) groups.set(fk, []);
    groups.get(fk).push(r);
  }
  const state = new Map();
  for (const [key, list] of groups) {
    let best = null;
    for (const r of list) {
      if (r.kind !== 'vote') continue;
      if (!best || Date.parse(r.at) >= Date.parse(best.at)) best = r; // mutante:a (gli import portano date in formati diversi)
    }
    const mutes = list.filter((r) => r.kind === 'mute');
    const last = mutes.length ? mutes[mutes.length - 1] : null;
    const on = last && (last.until === null || Date.parse(last.until) > now); // mutante:b
    const open = [];
    for (const r of list) {
      if (closed.has(r.id)) continue;
      if (r.kind === 'vote' && r === best && (r.v === 'cambia' || r.v === 'indietro')) open.push(r);
      else if (r.kind === 'note' || r.kind === 'complaint') open.push(r);
    }
    state.set(key, {
      vote: best ? { v: best.v, at: best.at, fp: best.fp, note: best.note, id: best.id } : null,
      notes: list.filter((r) => r.kind === 'note' || r.kind === 'complaint')
        .map((r) => ({ at: r.at, note: r.note, id: r.id, kind: r.kind })),
      mute: on ? { until: last.until, why: last.why, at: last.at, id: last.id } : null,
      fixes: list.filter((r) => r.kind === 'fix').map((r) => ({ at: r.at, why: r.why, id: r.id })),
      open,
      history: list,
    });
  }
  return state;
}

function emptyState() {
  return { vote: null, notes: [], mute: null, fixes: [], open: [], history: [] };
}

// Lo stato di una chiave, più «cambiata dopo la tua risposta».
export function stateFor(state, key, fp) {
  const s = state.get(key) || emptyState();
  return { ...s, changedSinceVote: !!(s.vote && fp && s.vote.fp && s.vote.fp !== fp) };
}

// Tutte le righe aperte, per `usage-hub feedback --open`.
export function openItems(state) {
  const out = [];
  for (const [key, s] of state) for (const row of s.open) out.push({ key, row });
  return out;
}

// I silenzi health: come { match, why }, per cron-health.
export function mutesAsAccepted(state) {
  const out = [];
  for (const [key, s] of state) {
    if (s.mute && key.startsWith('health:')) out.push({ match: key.slice('health:'.length), why: s.mute.why });
  }
  return out;
}

// Le correzioni cron: come { job, at, why }, per cron-health.
export function fixesForHealth(state) {
  const out = [];
  for (const [key, s] of state) {
    if (!key.startsWith('cron:')) continue;
    for (const f of s.fixes) out.push({ job: key.slice('cron:'.length), at: f.at, why: f.why });
  }
  return out;
}
