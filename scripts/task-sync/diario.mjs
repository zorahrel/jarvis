#!/usr/bin/env node
// Diario: ciò che succede nelle automazioni e non merita un messaggio ad Attilio finisce qui, una riga JSON per evento.
// Formato concordato con l'hub (sessione hub-ux, 24/10), che lo legge per la pagina Diario:
//   state/diario/YYYY-MM-DD.jsonl (data a Roma), append-only, nessuna rotazione (l'hub legge gli ultimi 30 giorni)
//   { ts: ms, source, text, kind?, ref?, outcome?: 'ok'|'error'|'skipped', link? }   obbligatori: ts, source, text
// «error» entra nel filtro Problemi dell'hub, «skipped» si vede come giro saltato. text è la frase per un umano.
//   diario.mjs "testo" [--source job] [--kind tipo] [--outcome ok|error|skipped] [--ref id] [--link url]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIARIO_DIR = process.env.DIARIO_DIR || path.join(os.homedir(), '.claude/jarvis/state/diario');

// Il giorno a Roma, non in UTC: un evento delle 00:30 va nel file di quel giorno.
const romeDay = (ts) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
export const fileFor = (ts, dir = DIARIO_DIR) => path.join(dir, `${romeDay(ts)}.jsonl`);

const OUTCOME = { errore: 'error', 'giro saltato': 'skipped' };

// eventi { text, kind?, ref?, outcome?, link? } → righe del diario.
export function diario(events, { source = 'task-sync', dir = DIARIO_DIR, now = Date.now() } = {}) {
  if (!events.length) return;
  const lines = events.map((e) => {
    const row = { ts: e.ts ?? now, source: e.source ?? source, text: e.text, kind: e.kind, ref: e.ref, outcome: e.outcome ?? OUTCOME[e.kind] ?? 'ok', link: e.link };
    for (const k of Object.keys(row)) if (row[k] == null) delete row[k];
    return JSON.stringify(row);
  });
  fs.mkdirSync(dir, { recursive: true });
  // Una sola write con O_APPEND: righe intere anche con più scrittori.
  fs.appendFileSync(fileFor(now, dir), lines.join('\n') + '\n');
}

function main() {
  const [text, ...rest] = process.argv.slice(2);
  const uso = 'uso: diario.mjs "testo" [--source job] [--kind tipo] [--outcome ok|error|skipped] [--ref id] [--link url]';
  // 24/10: «diario.mjs --help» scriveva «--help» nel Diario vero come se fosse un evento.
  if (text === '--help' || text === '-h') { console.log(uso); return; }
  if (!text || text.startsWith('-')) { console.error(uso); process.exit(64); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  // --who è il nome di prima, accettato ancora.
  diario([{ text, kind: opt.kind, ref: opt.ref, outcome: opt.outcome, link: opt.link }], { source: opt.source || opt.who || 'automazione' });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
