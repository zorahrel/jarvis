// Diario: cosa hanno fatto automazioni, workflow e agenti, in ordine di tempo, scritto per un umano.
// Legge solo ciò che l'hub ha già: i giri delle automazioni, i giri dei workflow, la coda dei lavori delegati
// e il registro dei feedback. Funzione pura: i dati arrivano da fuori.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXEC = { free: 'canali gratis', muse: 'Muse', codex: 'Codex', claude: 'Claude' };
const SYS = { openclaw: 'OpenClaw', launchd: 'Mac', desktop: 'Claude desktop', lobster: 'Lobster', workflow: 'Workflow', github: 'GitHub', pc: 'PC di casa' };
const VOTE = { ok: 'va bene', cambia: 'da cambiare', indietro: 'da rimettere com\'era' };

// La prima frase di un compito, abbastanza corta da stare su una riga.
export function firstLine(task, max = 110) {
  const s = String(task || '').replace(/\s+/g, ' ').trim();
  const cut = s.split(/(?<=[.!?:])\s/)[0] || s;
  return cut.length > max ? cut.slice(0, max - 1).replace(/\s\S*$/, '') + '…' : cut;
}

// Numeri di telefono ed email non escono mai dal diario, nemmeno se un compito li cita.
const mask = (s) => String(s || '').replace(/\+?\d[\d ]{8,}\d/g, '…').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '…@…');

// Diario scritto da altri (sync dei task e simili): una riga JSONL per evento in <dir>/YYYY-MM-DD.jsonl,
// {ts, source, text, kind?, ref?, outcome?, link?}. Si leggono solo i file dei giorni chiesti; una riga rotta si salta.
export const DIARY_DIR = process.env.USAGE_HUB_DIARIO || path.join(os.homedir(), '.claude/jarvis/state/diario');
const SRC = { 'task-sync': 'Task Topics ↔ Promemoria', delega: 'Coda delega', 'freno-mac': 'Freno del Mac', 'controllo-processi': 'Processi sospetti', 'quota-guard': 'Budget dei progetti', 'usage-hub-check': 'Soglie per progetto' };
const OUTCOMES = new Set(['ok', 'error', 'skipped']);
// Scrive righe nello stesso formato che scrivono gli altri (scripts/task-sync/diario.mjs): file del giorno a Roma, append.
const romeDay = (ts) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
export function appendDiary(rows, { dir = DIARY_DIR, now = Date.now() } = {}) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.text);
  if (!list.length) return;
  const lines = list.map((r) => { const o = { ts: r.ts ?? now, source: r.source || 'hub', text: String(r.text), kind: r.kind, ref: r.ref, outcome: r.outcome || 'ok', link: r.link };
    for (const k of Object.keys(o)) if (o[k] == null) delete o[k]; return JSON.stringify(o); });
  try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, romeDay(now) + '.jsonl'), lines.join('\n') + '\n'); } catch { /* il diario non deve fermare chi scrive */ }
}

export function readDiary({ dir = DIARY_DIR, now = Date.now(), days = 7 } = {}) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch { return out; }
  const first = new Date(now - (days + 1) * 86400000).toISOString().slice(0, 10);
  for (const f of files) {
    if (f.slice(0, 10) < first) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const at = typeof r.ts === 'number' ? r.ts : Date.parse(r.ts);
      if (!at || !r.text) continue;
      out.push({ at, source: String(r.source || ''), text: String(r.text), ref: r.ref ? String(r.ref) : null,
        outcome: OUTCOMES.has(r.outcome) ? r.outcome : null, link: typeof r.link === 'string' && /^(https?:|#)/.test(r.link) ? r.link : null });
    }
  }
  return out;
}

export function journal({ model, queue = [], feedback = [], diary = [], now = Date.now(), days = 7 } = {}) {
  const from = now - days * 86400000;
  const out = [];
  const cards = Object.values((model && model.cards) || {});
  const titleOf = (key) => ((model && model.cards && model.cards[key]) || {}).title || key;

  // Giri delle automazioni: uno per esito registrato. L'errore c'è solo per l'ultimo giro.
  for (const c of cards) {
    if (c.level === 'nascosto') continue;
    for (const h of c.history || []) {
      if (!h.at || h.at < from || h.at > now) continue;
      const last = c.last && c.last.at === h.at ? c.last : null;
      const err = h.outcome === 'error' && last && last.error ? String(last.error) : '';
      const delivered = last && last.delivered === 'failed' ? 'il messaggio non ti è arrivato' : last && last.delivered === 'delivered' ? 'ti è arrivato' : '';
      // riuscito ma il messaggio non è arrivato: per chi legge è un problema, non un ok
      const outcome = h.outcome === 'ok' && last && last.delivered === 'failed' ? 'undelivered' : h.outcome || null;
      // Computer e app di Attilio: tipo a parte, così il filtro Problemi resta di Jarvis.
      out.push({ at: h.at, kind: c.own ? 'app' : 'auto', who: SYS[c.provider] || c.provider || '', title: c.title, outcome,
        what: err ? firstLine(err, 140) : delivered, ref: c.key, link: '#automations/' + encodeURIComponent(c.key) });
    }
  }
  // Workflow lanciati dalle sessioni.
  for (const w of ((model && model.workflows) || {}).byName || []) {
    for (const r of w.runs || []) {
      if (!r.at || r.at < from || r.at > now) continue;
      const bits = [];
      if (r.agents != null) bits.push(r.agents + (r.agents === 1 ? ' agente' : ' agenti'));
      if (r.durationMs != null) bits.push(Math.max(1, Math.round(r.durationMs / 60000)) + ' min');
      out.push({ at: r.at, kind: 'workflow', who: 'Workflow', title: wfTitle(w.name), outcome: r.outcome || null,
        what: [r.summary ? firstLine(r.summary, 120) : '', bits.join(', ')].filter(Boolean).join(' · '), ref: 'wf:' + w.name, link: '#automations/' + encodeURIComponent('wf:' + w.name) });
    }
  }
  // Lavori delegati dalla coda: quando sono finiti, o quando sono partiti se girano ancora.
  for (const q of queue) {
    const at = q.endedAt || q.startedAt || q.createdAt;
    if (!at || at < from || at > now) continue;
    const outcome = q.status === 'done' ? 'ok' : q.status === 'failed' ? 'error' : q.status === 'running' ? 'running' : 'queued';
    const by = q.provider ? EXEC[q.provider] || q.provider : 'in attesa di un esecutore';
    out.push({ at, kind: 'agente', who: 'Agente · ' + by, title: mask(firstLine(q.task)), outcome,
      what: [q.project ? 'progetto ' + q.project : '', q.ref ? 'su ' + titleOf(q.ref) : '', q.exit != null && q.status === 'failed' ? 'uscito con codice ' + q.exit : ''].filter(Boolean).join(' · '),
      ref: q.ref || null, link: q.ref ? '#automations/' + encodeURIComponent(q.ref) : null });
  }
  // Quello che hai detto tu, e le richieste che un agente ha chiuso.
  const byId = new Map(feedback.map((r) => [r.id, r]));
  const undone = new Set(feedback.filter((r) => r.kind === 'undo').map((r) => r.ref));
  for (const r of feedback) {
    const at = typeof r.at === 'number' ? r.at : Date.parse(r.at);
    if (!at || at < from || at > now || undone.has(r.id)) continue;
    let title = '', what = '';
    if (r.kind === 'vote') { title = `Hai detto «${VOTE[r.v] || r.v}» su ${titleOf(r.key)}`; what = r.note ? mask(firstLine(r.note, 140)) : ''; }
    else if (r.kind === 'note' || r.kind === 'complaint') { title = `${r.kind === 'note' ? 'Nota' : 'Segnalazione'} su ${titleOf(r.key)}`; what = mask(firstLine(r.note, 140)); }
    else if (r.kind === 'mute') { title = `Hai silenziato ${titleOf(r.key)}`; what = r.why ? mask(firstLine(r.why, 140)) : ''; }
    else if (r.kind === 'fix') { title = `Un agente ha sistemato ${titleOf(r.key)}`; what = mask(firstLine(r.why, 160)); }
    else if (r.kind === 'resolve') { const o = byId.get(r.ref); title = `Un agente ha chiuso la richiesta su ${o ? titleOf(o.key) : 'un\'automazione'}`; what = r.commit ? 'con ' + mask(String(r.commit).slice(0, 80)) : ''; }
    else continue;
    const key = r.key || (byId.get(r.ref) || {}).key || null;
    const agent = r.kind === 'resolve' || r.kind === 'fix';
    out.push({ at, kind: agent ? 'agente' : 'tu', who: agent ? 'Agente' : 'Tu', title, outcome: agent ? 'ok' : null, what, ref: key, link: key ? '#automations/' + encodeURIComponent(key) : null });
  }
  for (const d of diary) {
    if (d.at < from || d.at > now) continue;
    out.push({ at: d.at, kind: 'auto', who: SRC[d.source] || d.source || 'Diario', title: mask(firstLine(d.text, 160)), outcome: d.outcome,
      what: '', ref: d.ref, link: d.link });
  }
  return out.sort((a, b) => b.at - a.at);
}

function wfTitle(name) {
  const s = String(name || '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Workflow';
}
