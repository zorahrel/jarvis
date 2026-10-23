#!/usr/bin/env node
// Hook di sessione (SessionStart / UserPromptSubmit): una riga solo se il progetto corrente è sopra budget.
// Legge solo la cache; se è vecchia lancia un refresh staccato e non aspetta.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheDir, readStatus, hookLine } from '../src/status.mjs';
import { sanitizeCwd } from '../src/budgets.mjs';

const STALE_MS = 15 * 60000;   // oltre: si riprova a ricalcolare in background
const REPEAT_MS = 30 * 60000;  // la stessa sessione ripete l'avviso al massimo ogni 30 minuti
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'usage-hub.mjs');

function readInput() {
  if (process.stdin.isTTY) return {};
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function refreshInBackground() {
  const lock = path.join(cacheDir(), 'refresh.lock');
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < 120000) return;
  } catch { /* nessun lock */ }
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(lock, String(process.pid));
    spawn(process.execPath, [bin, 'refresh'], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* l'hook non deve mai rompere la sessione */ }
}

try {
  const input = readInput();
  const dir = sanitizeCwd(input.cwd || process.cwd());
  const status = readStatus();
  if (!status || Date.now() - status.at > STALE_MS) refreshInBackground();
  // Cache di una settimana già chiusa: i numeri non valgono più, meglio tacere.
  if (status && status.weekResetsAt > Date.now()) {
    const p = Object.values(status.projects).find((x) => x.over && x.match.some((m) => dir.includes(m)));
    if (p) {
      const seenFile = path.join(cacheDir(), 'hook-seen.json');
      let seen = {};
      try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch { /* primo avviso */ }
      const sid = input.session_id;
      if (!sid || !seen[sid] || Date.now() - seen[sid] > REPEAT_MS) {
        console.log(hookLine(p));
        if (sid) {
          const now = Date.now();
          for (const k of Object.keys(seen)) if (now - seen[k] > 86400000) delete seen[k];
          seen[sid] = now;
          fs.writeFileSync(seenFile, JSON.stringify(seen));
        }
      }
    }
  }
} catch { /* muto */ }
