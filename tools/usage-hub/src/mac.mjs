// Carico del Mac e dei processi degli agenti. Le soglie sono quelle già in uso, non nuove:
//  - Topics (server/services/mem-signal.ts): swap «sostenuta» = pagine rilette da disco ≥ 10/s con debito di memoria ≥ 0,5 GB/min
//    su 60 s, oppure ≥ 200/s; la porta del «tetto» di Topics non è portata (serve lo storico di 2 finestre).
//  - offload (~/bin/offload): carico per core oltre 1,5 = Mac sotto sforzo.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export const MAX_LOAD_PER_CORE = 1.5;
export const PAGES_READ_BACK_PER_S = 10;
export const PAGES_READ_BACK_HARD_PER_S = 200;
export const DEBT_GB_PER_MIN = 0.5;
export const SWAP_WINDOW_MS = 60000;

// Percorsi assoluti: il hub gira sotto launchd, il cui PATH non ha /usr/sbin.
const BIN = { vm_stat: '/usr/bin/vm_stat', sysctl: '/usr/sbin/sysctl', ps: '/bin/ps', lsof: '/usr/sbin/lsof', footprint: '/usr/bin/footprint', ioreg: '/usr/sbin/ioreg' };
const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(BIN[cmd] || cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err && !out ? '' : String(out)));
});

export function parseVmStat(text) {
  const page = Number((text.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const n = (label) => { const m = text.match(new RegExp(label + ':\\s+(\\d+)')); return m ? Number(m[1]) : null; };
  return { pageSize: page, swapins: n('Swapins'), compressorPages: n('Pages occupied by compressor'), freePages: n('Pages free'), inactivePages: n('Pages inactive'), speculativePages: n('Pages speculative'),
    activePages: n('Pages active'), wiredPages: n('Pages wired down'), purgeablePages: n('Pages purgeable'), filePages: n('File-backed pages') };
}

// La RAM come la conta Activity Monitor (e la tray, MacStats.swift): usata = app + wired + compressa;
// la cache dei file (purgeable + file-backed) si libera da sola e non è «usata». In GB (2^30, come il Finder della RAM).
export function memBreakdown(v, totalBytes = os.totalmem()) {
  if ([v.activePages, v.inactivePages, v.speculativePages, v.wiredPages, v.compressorPages].some((x) => x == null)) return null;
  const g = (pages) => (pages * v.pageSize) / 2 ** 30, cached = g((v.purgeablePages || 0) + (v.filePages || 0));
  const used = g(v.activePages + v.inactivePages + v.speculativePages + v.wiredPages + v.compressorPages) - cached;
  const wired = g(v.wiredPages), compressed = g(v.compressorPages), total = totalBytes / 2 ** 30;
  // libera = né usata né cache: così le cinque voci sommano al totale (prima la cache contava due volte)
  return { totalGB: total, usedGB: used, appGB: Math.max(used - wired - compressed, 0), wiredGB: wired, compressedGB: compressed, cachedGB: cached, freeGB: Math.max(total - used - cached, 0) };
}
export function parseSwapUsage(text) {
  const used = text.match(/used = ([\d.]+)M/), total = text.match(/total = ([\d.]+)M/);
  return { swapUsedMB: used ? Number(used[1]) : null, swapTotalMB: total ? Number(total[1]) : null };
}

// Un campione del Mac: carico, memoria, swap.
export async function readMac(now = Date.now()) {
  const [vm, sw] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage'])]);
  const v = parseVmStat(vm), s = parseSwapUsage(sw), cores = os.cpus().length || 1;
  const availGB = v.freePages != null ? ((v.freePages + (v.inactivePages || 0) + (v.speculativePages || 0)) * v.pageSize) / 1e9 : null;
  return { at: now, cores, load1: os.loadavg()[0], loadPerCore: os.loadavg()[0] / cores, availGB, ...v, ...s };
}

// Pagine rilette da disco e debito di memoria sull'ultima finestra di 60 s: stesso verdetto di Topics.
export function swapVerdict(samples, now = Date.now()) {
  const none = { sustained: false, pagesReadBackPerS: null, debtGBPerMin: null };
  const last = samples[samples.length - 1];
  const base = [...samples].reverse().find((s) => s.at <= now - SWAP_WINDOW_MS);
  if (!last || !base || last === base) return none;
  const seconds = (last.at - base.at) / 1000;
  const f = [base.swapins, last.swapins, base.compressorPages, last.compressorPages, base.swapUsedMB, last.swapUsedMB, last.pageSize];
  if (seconds <= 0 || f.some((x) => x == null) || last.swapins < base.swapins) return none;
  const pagesReadBackPerS = (last.swapins - base.swapins) / seconds;
  const debtGB = ((last.compressorPages - base.compressorPages) * last.pageSize) / 1e9 + (last.swapUsedMB - base.swapUsedMB) / 1000;
  const debtGBPerMin = (debtGB * 60) / seconds;
  return {
    sustained: (pagesReadBackPerS >= PAGES_READ_BACK_PER_S && debtGBPerMin >= DEBT_GB_PER_MIN) || (pagesReadBackPerS >= PAGES_READ_BACK_HARD_PER_S && debtGBPerMin >= 0),
    pagesReadBackPerS, debtGBPerMin,
  };
}

// Il Mac è «sotto sforzo» se il carico per core supera 1,5 oppure la swap è sostenuta; il motivo è già una frase.
export function strain(sample, verdict, { maxLoadPerCore = MAX_LOAD_PER_CORE } = {}) {
  const fmt = (x) => x.toFixed(1).replace('.', ',');
  if (!sample) return { strained: false, reason: '' };
  const parts = [];
  if (sample.loadPerCore >= maxLoadPerCore) parts.push(`Mac a ${fmt(sample.loadPerCore)} per core`);
  if (verdict && verdict.sustained) parts.push(`memoria sotto pressione (${Math.round(verdict.pagesReadBackPerS)} pagine/s rilette da disco)`);
  const byLoad = sample.loadPerCore >= maxLoadPerCore, byMem = !!(verdict && verdict.sustained);
  return { strained: parts.length > 0, reason: parts.join(' e '), byLoad, byMem, calm: !byLoad && !byMem };
}

// ---- sforzo: un solo indicatore al posto di CPU, RAM, GPU e disco separati ----
// Soglie per componente in %: [impegnato, sotto sforzo]. La CPU è il carico per core (100% = un processo pronto per ogni core,
// 150% = la soglia di offload); la memoria è la pressione del kernel (100 − kern.memorystatus_level), e la swap sostenuta
// la porta comunque a «sotto sforzo»; il disco conta solo quando si riempie.
export const EFFORT_LIMITS = { cpu: [85, 97], mem: [80, 92], gpu: [80, 95], disk: [85, 95] };

// CPU occupata davvero (0-100%) tra una chiamata e la successiva, dai contatori di os.cpus(): si legge come «CPU al 40%».
// Il carico per core resta il criterio di offload: oltre 1 è «impegnato», oltre 1,5 «sotto sforzo» anche con CPU non piena.
let prevCpu = null;
export function cpuBusyPct(cpus = os.cpus()) {
  const t = cpus.reduce((a, c) => { const v = c.times; a.busy += v.user + v.nice + v.sys + v.irq; a.all += v.user + v.nice + v.sys + v.irq + v.idle; return a; }, { busy: 0, all: 0 });
  const prev = prevCpu; prevCpu = t;
  return prev && t.all > prev.all ? (100 * (t.busy - prev.busy)) / (t.all - prev.all) : null;
}
cpuBusyPct(); // primo campione all'avvio: la prima lettura del hub ha già un intervallo da misurare
export const EFFORT_NAMES = { cpu: 'CPU', mem: 'memoria', gpu: 'GPU', disk: 'disco' };

// Misure senza sudo e senza processi residenti: ioreg per la GPU, sysctl per la pressione di memoria, statfs per il disco.
export async function readExtras(dataVolume = '/System/Volumes/Data') {
  const [io, lvl] = await Promise.all([run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], 3000), run('sysctl', ['-n', 'kern.memorystatus_level'])]);
  const gpu = [...io.matchAll(/"Device Utilization %"=(\d+)/g)].map((m) => Number(m[1]));
  let diskUsedPct = null;
  let diskFreeGB = null, diskTotalGB = null;
  try { const st = fs.statfsSync(dataVolume); diskUsedPct = 100 * (1 - st.bavail / st.blocks); diskFreeGB = (st.bavail * st.bsize) / 1e9; diskTotalGB = (st.blocks * st.bsize) / 1e9; } catch {}
  const free = Number(lvl.trim());
  return { cpuPct: cpuBusyPct(), gpuPct: gpu.length ? Math.max(...gpu) : null, memPressurePct: Number.isFinite(free) && lvl.trim() !== '' ? 100 - free : null, diskUsedPct, diskFreeGB, diskTotalGB };
}

// Livello 0 tranquillo · 1 impegnato · 2 sotto sforzo; «driver» è la componente che pesa di più rispetto alla sua soglia.
export function effort(sample, verdict, extras = {}) {
  const parts = {
    cpu: extras.cpuPct ?? null,
    mem: extras.memPressurePct ?? null,
    gpu: extras.gpuPct ?? null,
    disk: extras.diskUsedPct ?? null,
  };
  const levelOf = (k, v) => (v == null ? 0 : v >= EFFORT_LIMITS[k][1] ? 2 : v >= EFFORT_LIMITS[k][0] ? 1 : 0);
  const load = sample ? sample.loadPerCore : 0;
  const loadLevel = load >= MAX_LOAD_PER_CORE ? 2 : load >= 1 ? 1 : 0;
  const rows = Object.entries(parts).map(([k, v]) => {
    const own = k === 'mem' && verdict && verdict.sustained ? 2 : levelOf(k, v);
    const level = k === 'cpu' ? Math.max(own, loadLevel) : own;
    const ratio = Math.max(v == null ? 0 : v / EFFORT_LIMITS[k][1], k === 'cpu' ? load / MAX_LOAD_PER_CORE : 0);
    return { key: k, name: EFFORT_NAMES[k], pct: v == null ? null : Math.round(v), level, ratio, ...(k === 'cpu' ? { load: Math.round(load * 10) / 10, byLoad: loadLevel > levelOf('cpu', v) } : {}) };
  });
  const worst = [...rows].sort((a, b) => b.level - a.level || b.ratio - a.ratio)[0];
  const level = worst.level;
  const label = ['tranquillo', 'impegnato', 'sotto sforzo'][level];
  const fmt = (x) => x.toFixed(1).replace('.', ',');
  const why = level === 0 ? ''
    : worst.key === 'mem' && verdict && verdict.sustained ? 'memoria piena, il Mac rilegge dalla swap'
    : worst.key === 'cpu' && loadLevel >= levelOf('cpu', worst.pct) ? `troppi processi in fila: ${fmt(load)} per core`
    : `${worst.name} al ${worst.pct}%`;
  return { level, label, driver: worst.key, why, score: Math.min(100, Math.round(worst.ratio * 100)), parts: rows.map(({ ratio, ...r }) => r) };
}

// ---- processi ----
export function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKB: Number(m[4]), etime: m[5], command: m[6] });
  }
  return rows;
}
export async function processTable() { return parsePs(await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command='], 6000)); }

export function descendants(table, rootPid) {
  const kids = new Map();
  for (const r of table) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r);
  const out = []; const stack = [rootPid]; const seen = new Set();
  while (stack.length) {
    const p = stack.pop(); if (seen.has(p)) continue; seen.add(p);
    const self = table.find((r) => r.pid === p); if (self) out.push(self);
    for (const k of kids.get(p) || []) stack.push(k.pid);
  }
  return out;
}

// Che cos'è un processo radice. «interattivo» = sessione davanti a una persona (mai in pausa); «sottoagente» = claude lanciato dal
// gateway OpenClaw; «codex-exec» e «muse-job» = lavori non interattivi; «sonda» = il processo di prova della pausa.
export function classify(row) {
  const c = row.command;
  if (/usage-hub-shed-probe/.test(c)) return 'sonda';
  if (/\/claude(\s|$)/.test(c) || /(^|\/)claude\s/.test(c)) return /\.openclaw\/tmp\/openclaw-cli-mcp-|--plugin-dir \/tmp\/openclaw/.test(c) ? 'sottoagente' : /\s-p(\s|$)|--print/.test(c) ? 'claude-job' : 'interattivo';
  if (/(^|\/)codex\s+exec\b/.test(c)) return 'codex-exec';
  if (/(^|\/)muse(agent)?\s/.test(c) && /\s(-p|--print|run|exec)\b/.test(c)) return 'muse-job';
  return 'altro';
}

// Un claude lanciato dal gateway OpenClaw porta la sua sessione in riga di comando (--resume / --session-id).
// Dallo stesso processo passano i sottoagenti e i turni delle chat (WhatsApp, Discord, Telegram): solo l'indice
// delle sessioni di OpenClaw sa chi è chi. In pausa va solo un sottoagente riconosciuto; chat e sconosciuti mai
// (22/10: lo shed teneva in SIGSTOP la risposta di Jarvis nella chat WhatsApp di Attilio).
export function cliSessionId(command) { return (/--(?:resume|session-id)[\s=]+([0-9a-f]{8}-[0-9a-f-]{27})/.exec(command || '') || [])[1] || null; }
export function openclawKind(row, resolve) {
  const id = cliSessionId(row.command);
  let bucket = null; try { bucket = id && resolve ? resolve(id) : null; } catch { /* indice illeggibile: come sconosciuto */ }
  return bucket && bucket.startsWith('openclaw/sub:') ? 'sottoagente' : 'chat-openclaw';
}

export function treeStats(table, rootPid) {
  const t = descendants(table, rootPid);
  return { pids: t.map((r) => r.pid), cpu: t.reduce((s, r) => s + r.cpu, 0) / 100, rssMB: t.reduce((s, r) => s + r.rssKB, 0) / 1024 };
}

// Footprint vero (phys_footprint): ps rss non conta la memoria compressa, e su Bun sbaglia di 30 volte (vedi memhog).
// Un solo `footprint` per tutti i pid: lanciarne uno per albero e uno per processo pesante era metà della CPU del hub.
// Ogni pid si rilegge al più ogni 2 minuti: `footprint` su decine di pid ogni 20 s era il 70% di un core (22/10),
// e la memoria di un processo non cambia di molto in due minuti.
const fpCache = new Map();
export async function footprintMap(pids, { now = Date.now(), ttlMs = 120000 } = {}) {
  const stale = [...new Set(pids)].filter((p) => !(fpCache.get(p)?.at > now - ttlMs));
  if (stale.length) {
    const got = parseFootprint(await run('footprint', stale.flatMap((p) => ['-p', String(p)]), 8000));
    for (const p of stale) fpCache.set(p, { at: now, mb: got.get(p) || 0 });   // 0 = non letto: si riprova al giro dopo i 2 minuti
  }
  for (const [p, e] of fpCache) if (e.at < now - 10 * ttlMs) fpCache.delete(p);
  return new Map(pids.filter((p) => fpCache.get(p)?.mb).map((p) => [p, fpCache.get(p).mb]));
}

// Righe «nome [pid]: ... Footprint: N MB» di `footprint -p a -p b`: memoria vera per pid, in MB.
export function parseFootprint(out) {
  const map = new Map();
  for (const m of out.matchAll(/\[(\d+)\]: .*?Footprint: ([\d.]+) (KB|MB|GB)/g)) map.set(Number(m[1]), Number(m[2]) * (m[3] === 'KB' ? 1 / 1024 : m[3] === 'GB' ? 1024 : 1));
  return map;
}

export async function cwdOf(pids) {
  if (!pids.length) return new Map();
  const out = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], 5000);
  const map = new Map(); let cur = null;
  for (const l of out.split('\n')) { if (l[0] === 'p') cur = Number(l.slice(1)); else if (l[0] === 'n' && cur != null) map.set(cur, l.slice(1)); }
  return map;
}

export async function startTime(pid) { return (await run('ps', ['-o', 'lstart=', '-p', String(pid)], 2000)).trim(); }

// Nome da persona per un processo pesante: «node 6,6 GB» il 23/10 sommava tre node diversi (gateway OpenClaw e due server
// TypeScript), e nessuno dei tre si capiva. `kind` dice al freno cosa può fare: 'gateway' si riavvia, il resto si segnala.
export function hogName(command) {
  const c = command || '';
  if (/openclaw\/dist\/index\.js gateway|openclaw-gateway/.test(c)) return { name: 'gateway OpenClaw', kind: 'gateway' };
  const ts = c.match(/\/([^/\s]+)\/node_modules\/typescript\/lib\/tsserver\.js/);
  if (ts) return { name: `server TypeScript di ${ts[1]}`, kind: 'tsserver' };
  // le sessioni Code dell'app Claude girano da un claude.app interno: senza questa riga erano «claude», come un comando qualsiasi
  if (/\/claude-code\/[^/]+\/[^/]+\/claude\.app\//.test(c)) return { name: 'sessioni Claude Code (app)', kind: 'sessione' };
  const app = (c.match(/\/([^/]+)\.app\//) || [])[1];
  if (app) return { name: app, kind: 'app' };
  const k = classify({ command: c });
  if (k === 'interattivo') return { name: 'sessione Claude', kind: 'sessione' };
  if (k !== 'altro') return { name: k === 'codex-exec' ? 'Codex' : k === 'muse-job' ? 'Muse' : 'Claude in background', kind: 'agente' };
  // node/bun/python nudi non dicono niente: il nome è il progetto o lo script che stanno facendo girare
  const bin = c.split(' ')[0].split('/').pop();
  if (/^(node|bun|python\d*(\.\d+)?|deno)$/i.test(bin)) {
    // il progetto è l'ultima cartella prima di node_modules, src, dist… (Projects/armonia-agency/armonia-site/node_modules → armonia-site)
    const segs = ((c.match(/\/Projects\/(\S+)/) || [])[1] || '').split('/');
    const stop = segs.findIndex((x, i) => i > 0 && (/^(node_modules|src|dist|server|bin|scripts|lib)$/.test(x) || /\.(m?js|ts|py)$/.test(x)));
    const proj = stop > 0 ? segs[stop - 1] : '';
    const script = (c.split(' ').slice(1).find((x) => /^[~/.].*\.(m?js|ts|py)$|^\/opt\/homebrew\/bin\//.test(x)) || '').split('/').pop().replace(/\.(m?js|ts|py)$/, '');
    const name = proj || (script && script !== 'index' ? script : '');
    if (name) return { name: `${bin} ${name}`, kind: 'altro' };
  }
  return { name: bin, kind: 'altro' };
}

// etime di ps («4-19:32:05», «19:32:05», «32:05») in secondi.
export function etimeSeconds(e) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(e || '');
  return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + +m[3] * 60 + +m[4]) : null;
}

// Il nome dice anche di chi è: un server MCP figlio del gateway MCP (il 24/10 wigolo era a 5,9 GB dopo 15 giorni, e la tray
// lo contava come «node mcp-hot-gateway ×12»), un server TypeScript figlio di una sessione Claude aperta da giorni.
function ownerOf(table, row) {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  for (let p = byPid.get(row.ppid), i = 0; p && i < 8; p = byPid.get(p.ppid), i++) {
    if (/mcp-hot-gateway/.test(p.command)) return { kind: 'mcp' };
    const k = classify(p);
    if (k === 'interattivo') return { kind: 'sessione', ageS: etimeSeconds(p.etime) };
    if (k !== 'altro') return { kind: 'agente' };
  }
  return null;
}

// Chi pesa di più sul Mac: scrematura su RSS e su CPU, footprint vero sui primi (stessa strada di memhog), raggruppati per nome da persona.
export async function topHogs(table, n = 3) {
  // 30 e non 12: un processo con la memoria compressa ha RSS basso (tsserver 277 MB di RSS, 3 GB veri) e restava fuori
  const byRss = [...table].sort((a, b) => b.rssKB - a.rssKB).slice(0, 30);
  const byCpu = [...table].sort((a, b) => b.cpu - a.cpu).slice(0, 5).filter((r) => !byRss.includes(r));
  const cand = [...byRss, ...byCpu];
  const fps = await footprintMap(cand.map((r) => r.pid));
  const out = [];
  for (const r of cand) {
    const fp = fps.get(r.pid);
    // Le app hanno spazi nel percorso («Google Chrome.app»): il nome è quello del bundle, non il primo pezzo prima dello spazio.
    let h = hogName(r.command);
    const own = h.kind === 'gateway' ? null : ownerOf(table, r);
    if (own && own.kind === 'mcp') h = { name: `MCP ${r.command.split(' ').map((x) => x.split('/').pop()).find((x) => x && !/^(node|python\d*|bun|uv|npx|npm|run|exec|tool|uvx)$/.test(x)) || h.name}`, kind: 'mcp' };
    const owner = own && own.kind === 'sessione' ? `di una sessione Claude aperta da ${Math.max(1, Math.round((own.ageS || 0) / 86400))} giorni` : '';
    out.push({ pid: r.pid, name: h.name, kind: h.kind, owner: own && own.kind === 'sessione' && own.ageS >= 86400 ? owner : '', ageS: etimeSeconds(r.etime), full: r.command.slice(0, 80), cpu: r.cpu / 100, memMB: fp || r.rssKB / 1024 });
  }
  const by = {};
  for (const o of out) { const k = o.name; by[k] = by[k] ? { ...by[k], memMB: by[k].memMB + o.memMB, cpu: by[k].cpu + o.cpu, ageS: Math.max(by[k].ageS || 0, o.ageS || 0), n: by[k].n + 1 } : { ...o, n: 1 }; }
  return Object.values(by).sort((a, b) => b.memMB - a.memMB).slice(0, n);
}
