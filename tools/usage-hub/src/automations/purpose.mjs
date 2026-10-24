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
  // Il computer e le app di Attilio (Mac, PC, darkroom, Topics): stanno a parte, fuori da problemi e «Ti aspetta» (Attilio, 23/10).
  { id: 'computer-app', title: 'Computer e app', own: true },
];
export const OWN_AREA = 'computer-app';
// Voci nuove di Mac, PC e app finiscono qui da sole, senza aspettare una riga in purpose.json.
const OWN_KEY = /topics-app|topics-db|darkroom|winfleet|tmpdir-sweep|devreap/i;
const AREA_IDS = new Set(AREAS.map((a) => a.id));

const TABLE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'purpose.json'), 'utf8'));

// Gruppo vecchio → area, solo per le voci che la tabella non conosce ancora.
const FROM_GROUP = { arriva: 'posta-avvisi', dati: 'backup-sicurezza', quote: 'jarvis-agenti', macchine: 'manutenzione', prodotti: 'sviluppo-topics' };

export function purposeOf(key, desc, group) {
  const row = TABLE[key] || {};
  const fromDesc = desc?.area && AREA_IDS.has(desc.area) ? desc.area : null;
  const fromTable = AREA_IDS.has(row.area) ? row.area : null;
  const fromKey = OWN_KEY.test(key) ? OWN_AREA : null;
  const area = fromDesc || fromKey || fromTable || FROM_GROUP[group] || 'manutenzione';
  const areaSource = fromDesc ? 'descrizione' : fromKey ? 'chiave' : fromTable ? 'tabella' : 'gruppo';
  return {
    area,
    areaSource,
    cosaFaPerTe: desc?.cosa || null,
    seSiRompe: row.seSiRompe || null,
  };
}
