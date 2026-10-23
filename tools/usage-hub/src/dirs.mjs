// Elenco di una cartella riletto solo se la sua data di modifica è cambiata: un file nuovo la cambia, uno che cresce no.
// Il hub elenca ~/.claude/projects (700 progetti, 960 sessioni) ogni minuto per gli agenti e ogni 5 per il report:
// rifare ogni volta i readdir, con un errore per ogni subagents assente, era la voce più cara della sua CPU.
import fs from 'node:fs';

const cache = new Map();

export function listDir(dir) {
  let st; try { st = fs.statSync(dir); } catch { cache.delete(dir); return []; }
  if (!st.isDirectory()) return [];
  const c = cache.get(dir);
  if (c && c.mtimeMs === st.mtimeMs) return c.names;
  let names; try { names = fs.readdirSync(dir); } catch { names = []; }
  cache.set(dir, { mtimeMs: st.mtimeMs, names });
  return names;
}
