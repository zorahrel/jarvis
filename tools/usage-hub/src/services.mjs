// Stato dei servizi AI del Mac per la scheda «Servizi»: chi è vivo, chi è fermo, quanta memoria vera usa, e i lavori
// launchd a orario che hanno chiuso male. Tre comandi (launchctl, ps, lsof) più footprint sui pid trovati: ~4 s di CPU con
// un centinaio di figli, per questo il hub lo calcola solo a scheda aperta e lo tiene un minuto.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './config.mjs';
import { footprintMap } from './mac.mjs';

const run = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err && !out ? '' : out || ''));
});

export function loadServices(file = path.join(ROOT, 'services.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).services || []; } catch { return []; }
}

// `launchctl list`: pid (o -), ultimo codice d'uscita, label.
export function parseLaunchctl(out) {
  const jobs = new Map();
  for (const line of out.split('\n').slice(1)) {
    const [pid, status, label] = line.split('\t');
    if (!label) continue;
    jobs.set(label, { pid: pid === '-' ? null : Number(pid), status: Number(status) });
  }
  return jobs;
}

// `lsof -iTCP -sTCP:LISTEN`: porta → pid.
export function parseListen(out) {
  const ports = new Map();
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    const m = /:(\d+)$/.exec(cols[8] || '');
    if (m && !ports.has(Number(m[1]))) ports.set(Number(m[1]), Number(cols[1]));
  }
  return ports;
}

// Stato per servizio: vivo, in attesa (parte alla richiesta), fermo (caricato senza processo), spento.
export function describe(services, { jobs, procs, ports, mem }) {
  return services.map((s) => {
    const job = s.label ? jobs.get(s.label) : null;
    let pid = job ? job.pid : null;
    if (!pid && s.match) { const p = procs.find((x) => x.cmd.includes(s.match)); if (p) pid = p.pid; }
    const listening = s.port ? ports.has(s.port) : null;
    let state;
    if (pid) state = 'vivo';
    else if (job && s.onDemand) state = 'in attesa';
    else if (job) state = 'fermo';
    else state = 'spento';
    // Un servizio con porta dichiarata che è vivo ma non ascolta non sta servendo nessuno.
    const problem = pid && s.port && !listening ? `non ascolta su :${s.port}`
      : !pid && job && !s.onDemand && job.status ? `uscito con codice ${job.status}` : null;
    // Memoria del processo e, a parte, con i figli: Topics è un lanciatore da 2 MB e il lavoro sta sotto,
    // OpenClaw e il gateway MCP portano con sé agenti e browser che hanno lanciato.
    const tree = pid ? family(pid, procs) : [];
    const sum = (list) => (list.some((p) => mem.has(p)) ? Math.round(list.reduce((t, p) => t + (mem.get(p) || 0), 0)) : null);
    return { ...s, state, pid, listening, mb: pid ? sum([pid]) : null, treeMb: tree.length > 1 ? sum(tree) : null, children: tree.length - 1, problem };
  });
}

export function family(pid, procs) {
  const out = [pid];
  for (let i = 0; i < out.length; i++) for (const p of procs) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
  return out;
}

// Lavori launchd di casa (com.jarvis.*, com.jcode.*, com.armonia.*) senza processo e non elencati sopra: girano a orario.
export function timers(services, jobs) {
  const known = new Set(services.map((s) => s.label).filter(Boolean));
  return [...jobs].filter(([label, j]) => /^(com\.jarvis|com\.jcode|com\.armonia)\./.test(label) && !known.has(label) && !j.pid)
    .map(([label, j]) => ({ label, status: j.status }))
    .sort((a, b) => (b.status !== 0) - (a.status !== 0) || a.label.localeCompare(b.label));
}

export async function servicesSnapshot(services = loadServices()) {
  const [lc, ps, ls] = await Promise.all([
    run('/bin/launchctl', ['list']),
    run('/bin/ps', ['-axo', 'pid=,ppid=,command=']),
    run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']),
  ]);
  const jobs = parseLaunchctl(lc);
  const procs = ps.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const ports = parseListen(ls);
  const first = describe(services, { jobs, procs, ports, mem: new Map() });
  const pids = first.flatMap((s) => (s.pid ? family(s.pid, procs) : []));
  const mem = await footprintMap(pids);
  return { at: Date.now(), services: describe(services, { jobs, procs, ports, mem }), timers: timers(services, jobs) };
}
