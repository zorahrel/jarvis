// Scopo di ogni voce per Attilio: in quale area sta, che cosa fa per lui, che cosa perde se si rompe.
// L'area viene, nell'ordine, dal campo area della descrizione, dalla tabella purpose.json, poi dal gruppo vecchio
// (così una voce nuova non resta senza area). Puro: i dati stanno in purpose.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AREAS = [
  { id: 'posta-avvisi', title: 'Posta e avvisi' },
  { id: 'clienti', title: 'Clienti' },
  { id: 'sviluppo-topics', title: 'Sviluppo' },
  { id: 'jarvis-agenti', title: 'Jarvis e agenti' },
  { id: 'manutenzione', title: 'Manutenzione' },
  { id: 'backup-sicurezza', title: 'Backup e sicurezza' },
];
const AREA_IDS = new Set(AREAS.map((a) => a.id));

const TABLE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'purpose.json'), 'utf8'));

// Gruppo vecchio → area, solo per le voci che la tabella non conosce ancora.
const FROM_GROUP = { arriva: 'posta-avvisi', dati: 'backup-sicurezza', quote: 'jarvis-agenti', macchine: 'manutenzione', prodotti: 'sviluppo-topics' };

export function purposeOf(key, desc, group) {
  const row = TABLE[key] || {};
  const fromDesc = desc?.area && AREA_IDS.has(desc.area) ? desc.area : null;
  const fromTable = AREA_IDS.has(row.area) ? row.area : null;
  const area = fromDesc || fromTable || FROM_GROUP[group] || 'manutenzione';
  const areaSource = fromDesc ? 'descrizione' : fromTable ? 'tabella' : 'gruppo';
  return {
    area,
    areaSource,
    cosaFaPerTe: desc?.cosa || null,
    seSiRompe: row.seSiRompe || null,
  };
}
