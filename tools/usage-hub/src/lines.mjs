// Lettura a basso impatto dei log JSONL: un buffer unico riusato, ricerca della parola chiave nei byte, e solo le righe
// che la contengono diventano stringhe. Leggere un log intero con readFileSync portava il report a 2,66 GB di picco.
import fs from 'node:fs';

const BASE = 4 * 1024 * 1024;
const buf = Buffer.allocUnsafe(BASE);

// fn(line) per ogni riga completa che contiene almeno una delle needles; from = byte da cui partire.
// Restituisce l'offset dopo l'ultima riga completa (una riga a metà scrittura resta per il giro dopo).
export function forEachLine(file, needles, fn, { from = 0, size } = {}) {
  const keys = needles.map((n) => Buffer.from(n));
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return from; }
  try {
    const end = size ?? fs.fstatSync(fd).size;
    let base = from, filled = 0;
    while (base + filled < end) {
      const n = fs.readSync(fd, buf, filled, Math.min(buf.length - filled, end - base - filled), base + filled);
      if (!n) break;
      filled += n;
      const cut = buf.lastIndexOf(10, filled - 1) + 1;
      if (!cut) {
        if (filled < buf.length) continue;
        // Riga più lunga del buffer (Codex ne scrive da 34 MB): si scorre senza tenerla in memoria.
        const next = skipLongLine(fd, keys, base, end, fn);
        if (next === null) return base; // riga ancora a metà: si riprende da qui al giro dopo
        base = next; filled = 0;
        continue;
      }
      const view = buf.subarray(0, cut);
      // Le righe che contengono una chiave, in ordine di posizione e una volta sola anche se ne contengono più d'una.
      const starts = new Set();
      for (const k of keys) for (let i = view.indexOf(k); i !== -1; i = view.indexOf(k, view.indexOf(10, i) + 1)) starts.add(view.lastIndexOf(10, i) + 1); // view finisce con \n: la fine riga c'è sempre
      for (const ls of [...starts].sort((a, b) => a - b)) fn(view.toString('utf8', ls, view.indexOf(10, ls)));
      buf.copy(buf, 0, cut, filled); filled -= cut; base += cut;
    }
    return base;
  } finally { fs.closeSync(fd); }
}

// Riga lunga che parte da `start`: la legge a blocchi cercando chiavi e fine riga. Solo se contiene una chiave
// la si rilegge intera (raro); altrimenti si salta. Restituisce l'offset dopo il \n, o null se la riga non è finita.
function skipLongLine(fd, keys, start, end, fn) {
  const tail = Math.max(...keys.map((k) => k.length)) - 1; // una chiave a cavallo di due blocchi
  let pos = start, kept = 0, hit = false;
  while (pos < end) {
    const n = fs.readSync(fd, buf, kept, Math.min(buf.length - kept, end - pos), pos);
    if (!n) return null;
    const filled = kept + n;
    const nl = buf.indexOf(10, kept);
    const upto = nl === -1 ? filled : nl;
    if (!hit) hit = keys.some((k) => { const i = buf.indexOf(k); return i !== -1 && i + k.length <= upto; });
    if (nl !== -1) {
      const lineEnd = pos + (nl - kept);
      if (hit) {
        const line = Buffer.allocUnsafe(lineEnd - start);
        fs.readSync(fd, line, 0, line.length, start);
        fn(line.toString('utf8'));
      }
      return lineEnd + 1;
    }
    pos += n;
    kept = Math.min(tail, filled);
    buf.copy(buf, 0, filled - kept, filled);
  }
  return null;
}
