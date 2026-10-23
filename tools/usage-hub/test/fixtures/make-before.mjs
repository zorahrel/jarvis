// Una tantum, PRIMA di copiare il codice nell'hub: fotografa cosa producono gli originali di ~/.openclaw/bin
// sulle fixture sintetiche. I test di parità confrontano la copia con questa foto; rigenerarla dopo la copia
// non proverebbe niente (la barra controlla che il commit della foto venga prima di quello della copia).
//   node test/fixtures/make-before.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const bin = path.join(os.homedir(), '.openclaw/bin');
const m = await import(path.join(bin, 'automazioni-map.mjs'));
const h = await import(path.join(bin, 'cron-health.mjs'));

const { jobs } = JSON.parse(fs.readFileSync(path.join(here, 'automations/openclaw-jobs.json'), 'utf8'));
const cron = jobs.map((r) => {
  const j = { id: r.job_id, name: r.name, enabled: !!r.enabled, ...r.job };
  const cond = m.condOf(j);
  return { key: `cron:${j.id}`, when: m.whenOf(j.schedule), cond, who: m.whoOf(j), out: m.outOf(j), times: m.timesOfCron(j.schedule, cond) };
});
const ldir = path.join(here, 'automations/launchd');
const launchd = fs.readdirSync(ldir).filter((f) => f.endsWith('.plist')).sort().map((f) => {
  const p = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(ldir, f)], { encoding: 'utf8' }));
  return { label: p.Label, times: m.timesOfLaunchd(p) };
});
const fps = ['', 'Va bene|mai|', 'Ogni ora fa una cosa di prova.|WhatsApp, solo se serve|echo ciao', 'àèìòù € 😀'].map((s) => [s, m.fp(s)]);
fs.writeFileSync(path.join(here, 'automazioni-map-before.json'), JSON.stringify({ cron, launchd, fps }, null, 1) + '\n');

const facts = JSON.parse(fs.readFileSync(path.join(here, 'cron-health/facts.json'), 'utf8'));
const accepted = JSON.parse(fs.readFileSync(path.join(here, 'cron-health/accept.json'), 'utf8'));
const before = { raw: h.findings({ ...facts, accepted: [] }), accepted: h.findings({ ...facts, accepted }) };
fs.writeFileSync(path.join(here, 'cron-health/before.json'), JSON.stringify(before, null, 1) + '\n');
console.log(`${cron.length} cron, ${launchd.length} plist, ${before.raw.length} righe grezze, ${before.accepted.length} dopo gli accettati`);
