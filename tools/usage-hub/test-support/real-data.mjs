// I dati veri di Attilio che test e demo non devono mai toccare né mostrare: diario, «Ti aspetta», feedback delle
// automazioni, numero di WhatsApp (notify.json e config locale). I percorsi seguono HOME: nella barra
// (scripts/tmp-leak-check.sh) HOME è una cartella finta con dentro delle sentinelle, e HUB_TEST_SANDBOX=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const realPaths = () => {
  const h = os.homedir();
  return {
    diary: path.join(h, '.claude/jarvis/state/diario'),
    attesa: path.join(h, '.claude/jarvis/private/ti-aspetta.jsonl'),
    feedback: path.join(h, '.claude/jarvis/private/automazioni/feedback'),
    notify: path.join(h, '.config/claude-usage-hub/notify.json'),
    local: path.join(h, '.config/claude-usage-hub/local.json'),
  };
};

const files = (p) => { try { return fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => files(path.join(p, f))) : [p]; } catch { return []; } };

// Fotografia dei file veri: percorso → contenuto.
export function snapshotReal() {
  const out = {};
  for (const p of Object.values(realPaths())) for (const f of files(p)) { try { out[f] = fs.readFileSync(f, 'utf8'); } catch { /* sparito */ } }
  return out;
}

// Cosa è cambiato fra due fotografie. Nella barra (sandbox) nessuno scrive lì, quindi ogni differenza è di un test;
// fuori dalla barra l'hub vivo scrive nel diario mentre i test girano, e il confronto non si fa ([]).
export function realChanges(before, after = snapshotReal()) {
  if (process.env.HUB_TEST_SANDBOX !== '1') return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).map((k) => (k in before ? (k in after ? 'cambiato ' : 'tolto ') : 'nuovo ') + k);
}

// Testi veri che non devono comparire in una risposta della demo: righe del diario degli ultimi giorni, titoli e
// motivi di «Ti aspetta», il numero di WhatsApp. Solo stringhe di almeno 8 caratteri (niente falsi positivi corti).
export function realStrings() {
  const out = new Set(), { diary, attesa, notify, local } = realPaths();
  const take = (s) => { if (typeof s === 'string' && s.trim().length >= 8) out.add(s.trim()); };
  for (const f of files(diary).sort().slice(-3)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { try { take(JSON.parse(l).text); } catch { /* riga rotta */ } }
  try { for (const l of fs.readFileSync(attesa, 'utf8').split('\n')) { try { const r = JSON.parse(l); take(r.title); take(r.why); } catch { /* riga rotta */ } } } catch { /* nessun file */ }
  const leaves = (o) => (o && typeof o === 'object' ? Object.values(o).flatMap(leaves) : [o]);
  for (const f of [notify, local]) {
    try { for (const v of leaves(JSON.parse(fs.readFileSync(f, 'utf8')))) { take(v); const d = String(v).replace(/\D/g, ''); if (d.length >= 9) { out.add(d); out.add(d.slice(-10)); } } } catch { /* nessun file */ }
  }
  return [...out];
}

// Un numero di telefono o un indirizzo WhatsApp in una risposta JSON, in qualunque forma: +39 333 000 1122,
// +39-333-000-1122, +39.333.000.1122, con spazi non separabili, +39 (333) 000-1122, 0039…, 333-000-1122, wa.me/…,
// …@s.whatsapp.net; e come numero JSON (3330001122). Date e orari ISO non contano. Restituisce i primi trovati.
const SEP = /(?<=\d)[\s\u00a0\u202f().\-/]+(?=[\d(])|(?<=\+\d{1,3})[\s\u00a0\u202f(]+(?=\d)/g;
export const phoneDigits = (s) => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ').replace(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, ' ').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ').replace(SEP, '').replace(/[()]/g, '');
// numeri JSON che sono misure, non telefoni: millisecondi, token, byte, durate, conteggi
const MEASURE = /(^|[a-z])(ts|at|At|ms|Ms|time|Time|start|end|until|reset|expires|tokens?|Tokens?|bytes|size|count|Count|duration|weighted|total|cost|n|t|c|i|o)$/;
export function phoneLike(json) {
  const hits = [];
  const walk = (v, k) => {
    if (typeof v === 'string') {
      const d = phoneDigits(v);
      if (/\+?\d{9,13}(?!\d)/.test(d) && !/^\d{13}$/.test(v) || /[@＠]s\.whatsapp\.net|wa\.me\//i.test(v)) hits.push(k + ': ' + v.slice(0, 60));
    } else if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 1e8 && v < 1e12 && !MEASURE.test(k)) hits.push(k + ': ' + v);
    } else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(json, '');
  return hits.slice(0, 5);
}
