// Canali gratis (free-router): il log ha solo un "ok <canale>" per richiesta, senza token né cwd.
// Si contano le richieste per canale nella finestra: costano zero quota, ma vanno viste.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultFreeLog = () => path.join(os.homedir(), '.claude', 'jarvis', 'logs', 'free-router.log');

export function scanFree({ file = defaultFreeLog(), sinceMs = 0 } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const channels = {};
  let requests = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:]+) ok (\S+)/);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const c = (channels[m[2]] ||= { requests: 0, lastAt: 0 });
    c.requests += 1;
    if (ts > c.lastAt) c.lastAt = ts;
    requests += 1;
  }
  return { requests, channels };
}
