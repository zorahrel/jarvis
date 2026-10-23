import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Config locale, fuori dal repo: i nomi di clienti, account e progetti veri stanno qui, non nel codice pubblico.
// File mancante o illeggibile = config vuota, senza errore.
let cached = null;

export function localConfig() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'claude-usage-hub', 'local.json'), 'utf8'));
  } catch {
    cached = {};
  }
  return cached;
}
