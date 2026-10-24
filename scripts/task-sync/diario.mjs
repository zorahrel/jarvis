#!/usr/bin/env node
// Diario: ciò che succede nelle automazioni e non merita un messaggio ad Attilio finisce qui, una riga JSON per evento.
// Ogni riga ha la forma di un elemento del diario dell'hub (tools/usage-hub/src/journal.mjs):
//   { at: ms, kind, who, title, outcome: 'ok'|'error'|null, what, ref, link }
// così l'hub la mostra com'è. Un file al mese in state/diario/, append-only.
//   diario.mjs "titolo" [--who Chi] [--kind auto] [--outcome ok|error] [--what dettaglio] [--ref id]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIARIO_DIR = process.env.DIARIO_DIR || path.join(os.homedir(), '.claude/jarvis/state/diario');

export const fileFor = (at, dir = DIARIO_DIR) => path.join(dir, `${new Date(at).toISOString().slice(0, 7)}.jsonl`);

const ERR = new Set(['errore', 'giro saltato']);

// Gli eventi del sync dei task: { kind, text, ref } → righe del diario.
export function diario(events, { who = 'Sync task', dir = DIARIO_DIR, now = Date.now() } = {}) {
  if (!events.length) return;
  const lines = events.map((e) => JSON.stringify({
    at: e.at ?? now, kind: e.hubKind ?? 'task', who: e.who ?? who, title: e.text ?? e.title,
    outcome: e.outcome ?? (ERR.has(e.kind) ? 'error' : 'ok'), what: e.what ?? e.kind ?? '', ref: e.ref ?? null, link: e.link ?? null,
  }));
  fs.mkdirSync(dir, { recursive: true });
  // Una sola write con O_APPEND: righe intere anche con più scrittori.
  fs.appendFileSync(fileFor(now, dir), lines.join('\n') + '\n');
}

function main() {
  const [title, ...rest] = process.argv.slice(2);
  if (!title) { console.error('uso: diario.mjs "titolo" [--who Chi] [--kind auto] [--outcome ok|error] [--what dettaglio] [--ref id]'); process.exit(64); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  diario([{ title, who: opt.who, hubKind: opt.kind || 'auto', outcome: opt.outcome || null, what: opt.what || '', ref: opt.ref || null }], { who: opt.who || 'Automazione' });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
