// «Ti aspetta»: solo ciò che tocca ad Attilio (una decisione, una spesa, qualcosa che va in pubblico, un ok a vista).
// Registro append-only in un JSONL fuori dal repo: gli agenti aprono una voce, Attilio o l'agente la chiudono.
// Le voci sono dati di persone vere: il file sta nel repo privato cifrato.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const TIPI = ['decisione', 'spesa', 'pubblico', 'vista'];
export const attesaFile = () => process.env.USAGE_HUB_ATTESA || path.join(os.homedir(), '.claude', 'jarvis', 'private', 'ti-aspetta.jsonl');

function rows(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of txt.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* riga rotta: si salta */ } }
  return out;
}

// Voci aperte: ogni «apri» senza un «chiudi» che la nomini. Le più vecchie prima: aspettano da più tempo.
export function readAttesa({ file = attesaFile() } = {}) {
  const all = rows(file);
  const closed = new Set(all.filter((r) => r.kind === 'chiudi').map((r) => r.ref));
  return all.filter((r) => r.kind === 'apri' && !closed.has(r.id)).sort((a, b) => a.at - b.at)
    .map(({ id, tipo, title, why, link, from, at }) => ({ id, tipo, title, why: why || '', link: link || null, from: from || '', at }));
}

// Un errore in parole, o null se la riga va bene.
export function validateAttesa(b) {
  if (b.kind === 'chiudi') return b.ref ? null : 'manca ref della voce da chiudere';
  if (!TIPI.includes(b.tipo)) return 'tipo: ' + TIPI.join(', ');
  if (!b.title || typeof b.title !== 'string') return 'manca title';
  if (b.link && !/^(https?:\/\/|#)/.test(b.link)) return 'link: http(s) o #pagina';
  return null;
}

export function writeAttesa(b, { file = attesaFile(), now = Date.now() } = {}) {
  const row = b.kind === 'chiudi'
    ? { kind: 'chiudi', ref: b.ref, by: b.by || 'hub', note: b.note || '', at: now }
    : { kind: 'apri', id: crypto.randomBytes(4).toString('hex'), tipo: b.tipo, title: String(b.title).slice(0, 200), why: String(b.why || '').slice(0, 600), link: b.link || null, from: String(b.from || '').slice(0, 80), at: now };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

// Dalle automazioni entra solo il cancello di un workflow: un passo fermo che aspetta il suo ok è una decisione sua.
// Gli altri «ti aspetta» delle automazioni (avvisi, soglie, doctor) restano nella loro pagina, con «Risolvi tu».
export function fromAutomations(model) {
  const out = [];
  const seen = new Set();
  for (const c of [...(model?.needsYou || []), ...Object.values(model?.cards || {})]) {
    if (!c || seen.has(c.key) || c.level !== 'te') continue;
    seen.add(c.key);
    const m = /passo «([^»]+)»/.exec(c.reason || '');
    if (!m) continue;
    out.push({ id: 'auto:' + c.key, tipo: 'decisione', title: `Ok al passo «${m[1]}» di ${c.title}`, why: c.reason, link: '#automations/' + encodeURIComponent(c.key), from: 'automazioni', at: c.since || model.checkedAt, auto: true });
  }
  return out;
}
