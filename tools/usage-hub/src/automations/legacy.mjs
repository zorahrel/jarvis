// Import una tantum del giudizio sparso in tre posti (conferme dell'artifact, cron-health.accept.json, cron-health.fixes.json)
// in righe di feedback. Puro: chi lo usa decide dove scrivere.
import { operatore } from '../operatore.mjs';

const at0 = '2026-10-23T00:00:00.000Z';

export function legacyRows({ conferme = [], accept = [], fixes = [], migrations = [] } = {}) {
  const rows = [];
  const by = operatore();
  // conferme: documento = chiave, {v, at, fp, note?}; l'ora e l'impronta originali restano, così «cambiata dopo» funziona
  for (const d of conferme) {
    const key = d.key || d.doc_id || d.id;
    if (!key || !d.v) continue;
    rows.push({ key, kind: 'vote', v: d.v, at: d.at || at0, fp: d.fp ?? null, ...(d.note ? { note: d.note } : {}), by, src: 'artifact' });
  }
  // accettati di cron-health: silenzi per sempre su quella riga, col loro perché
  for (const a of accept) rows.push({ key: `health:${a.match}`, kind: 'mute', until: null, why: a.why, at: at0, by, src: 'cron-health.accept' });
  // correzioni: di quel job si giudica solo ciò che viene dopo «at»
  for (const f of fixes) rows.push({ key: `cron:${f.job}`, kind: 'fix', at: new Date(f.at).toISOString(), why: f.why, by: 'agente', src: 'cron-health.fixes' });
  for (const m of migrations) rows.push({ key: m.from, kind: 'migration', from: m.from, to: m.to, at: m.at || at0, why: m.why, by: 'agente', src: 'import' });
  return rows;
}
