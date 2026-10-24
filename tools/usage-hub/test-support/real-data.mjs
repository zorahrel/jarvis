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
  const out = new Set(), { diary, attesa, notify } = realPaths();
  const take = (s) => { if (typeof s === 'string' && s.trim().length >= 8) out.add(s.trim()); };
  for (const f of files(diary).sort().slice(-3)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { try { take(JSON.parse(l).text); } catch { /* riga rotta */ } }
  try { for (const l of fs.readFileSync(attesa, 'utf8').split('\n')) { try { const r = JSON.parse(l); take(r.title); take(r.why); } catch { /* riga rotta */ } } } catch { /* nessun file */ }
  try { const n = JSON.parse(fs.readFileSync(notify, 'utf8')); for (const v of Object.values(n)) { take(v); const d = String(v).replace(/\D/g, ''); if (d.length >= 8) out.add(d); } } catch { /* nessun file */ }
  return [...out];
}

// Un numero di telefono o un indirizzo WhatsApp dentro una stringa di una risposta JSON (le date in millisecondi
// sono numeri, non stringhe: non contano). Restituisce i primi trovati.
export function phoneLike(json) {
  const hits = [];
  const walk = (v, k) => {
    if (typeof v === 'string') { if (/\+?\d[\d ]{8,}\d|[@＠]s\.whatsapp\.net|wa\.me\//i.test(v.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, ''))) hits.push(k + ': ' + v.slice(0, 60)); }
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(json, '');
  return hits.slice(0, 5);
}
