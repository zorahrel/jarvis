#!/usr/bin/env node
// Salute delle automazioni OpenClaw (il cron delle 8:45 lancia ~/.openclaw/bin/cron-health.mjs, che importa questo).
// Stampa solo ciò che non va, una riga per problema, ed esce 0: OpenClaw consegna solo se l'output non è vuoto,
// e nessuno leggeva l'exit 1 (che segnava il cron stesso come rotto). Scrive anche i findings per la scheda Automazioni.
//   cron-health.mjs [--all]
// Silenzi e correzioni vengono dal feedback (mute «health:<testo>», fix «cron:<id>»), non più dai due JSON.
// CRON_HEALTH_FACTS=<file.json>: fatti congelati al posto della CLI di OpenClaw (prova di parità, nessuna scrittura).
import fs from 'node:fs';
import path from 'node:path';
import { findings, readFacts } from '../src/automations/health.mjs';
import { readAll, buildState, mutesAsAccepted, fixesForHealth } from '../src/automations/feedback.mjs';
import { healthFile } from '../src/automations/index.mjs';

const state = buildState(readAll().rows);
const accepted = mutesAsAccepted(state), fixes = fixesForHealth(state);
const frozen = process.env.CRON_HEALTH_FACTS;
const f = frozen ? { ...JSON.parse(fs.readFileSync(frozen, 'utf8')), accepted } : readFacts({ accepted, fixes });
const out = findings(f);
if (!frozen) {
  fs.mkdirSync(path.dirname(healthFile()), { recursive: true });
  fs.writeFileSync(healthFile(), JSON.stringify({ at: Date.now(), active: f.jobs.filter((j) => j.enabled).length, findings: out }) + '\n');
}
if (out.length) {
  console.log(`Automazioni OpenClaw: ${out.length} ${out.length === 1 ? 'cosa' : 'cose'} da sistemare`);
  for (const o of out) console.log(`• [${o.kind}] ${o.line}`);
} else if (process.argv.includes('--all')) console.log(`Automazioni OpenClaw: ${f.jobs.filter((j) => j.enabled).length} attive, tutto a posto`);
