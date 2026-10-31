#!/usr/bin/env node
// Misura i token l'ora dei direttori in un giorno e li confronta col riferimento del 24/10 (preso a mezzanotte da un cron, in
// tools/usage-hub/data/). Stampa una riga sola, in italiano. Il calcolo è quello dell'hub (scripts/direttori-token-ora.mjs): non lo rifà.
//   node direttori-token-confronto.mjs [YYYY-MM-DD] [--riferimento FILE]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HUB = path.join(os.homedir(), '.claude/jarvis/tools/usage-hub');
const arg = process.argv.slice(2);
const day = arg.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
const ri = arg.indexOf('--riferimento');
const refFile = ri >= 0 ? arg[ri + 1] : path.join(HUB, 'data/direttori-token-ora-2026-10-24.json');

const now = JSON.parse(execFileSync(process.execPath, [path.join(HUB, 'scripts/direttori-token-ora.mjs'), day, '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
// il giorno misurato resta accanto al riferimento, scritto in un colpo solo; il riferimento stesso non si riscrive mai
const out = path.join(HUB, `data/direttori-token-ora-${day}.json`);
if (path.resolve(out) !== path.resolve(refFile)) {
  fs.writeFileSync(`${out}.nuovo`, JSON.stringify(now, null, 1));
  fs.renameSync(`${out}.nuovo`, out);
}
const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));

const M = (n) => (n / 1e6).toFixed(1).replace('.', ',');
const dm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');
const byTitle = new Map(ref.sessions.map((s) => [s.title, s]));
const pct = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}%` : 'nuovo');
const perHour = (t) => (t.activeHours ? t.weighted / t.activeHours : 0);

const top = now.sessions.slice(0, 3).map((s) => {
  const before = byTitle.get(s.title);
  return `${s.title} ${M(s.weightedPerHour)} M/h (${before ? `era ${M(before.weightedPerHour)}, ${pct(s.weightedPerHour, before.weightedPerHour)}` : 'non c\'era'})`;
});
console.log(`Token l'ora dei direttori, ${dm(day)} contro ${dm(ref.day)}: somma delle sessioni ${M(perHour(now.total))} M/h contro ${M(perHour(ref.total))} (${pct(perHour(now.total), perHour(ref.total))}), `
  + `totale pesato ${M(now.total.weighted)} M contro ${M(ref.total.weighted)}. Più pesanti: ${top.join('; ')}.`);
