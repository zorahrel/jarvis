#!/usr/bin/env node
// Comando di notifica di `usage-hub check` (config.json → alerts.notify.command): l'evento arriva in JSON su stdin
// e diventa una riga del diario dell'hub, con la voce del suo tipo (soglia di un progetto, di un abbonamento,
// ritmo Muse, esaurito, fuori dal proxy). Niente WhatsApp: il consumo si guarda nell'hub (P05, 24/10).
import { appendDiary } from '../src/journal.mjs';

let raw = '';
for await (const c of process.stdin) raw += c;
let e = {};
try { e = JSON.parse(raw || '{}'); } catch { /* sotto: senza evento si usa l'ambiente */ }
const text = e.message || process.env.USAGE_HUB_MESSAGE;
if (!text) { console.error('notify-diario: nessun evento'); process.exit(64); }
appendDiary({ text, source: e.source || process.env.USAGE_HUB_SOURCE || 'usage-hub-check', kind: e.kind || process.env.USAGE_HUB_KIND || 'soglia', ref: e.id, outcome: 'ok' });
