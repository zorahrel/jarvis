import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Le macchine come un elenco uniforme, per la tray: ogni fonte (questo Mac, il PC via pc-state, domani altre e di altri)
// diventa lo stesso oggetto e la tray disegna la stessa card. Qui stanno gli adattatori, vicino alle fonti; la tray non
// conosce nomi né casi.
//   { id, name, local, state, level (0 ok · 1 impegnato · 2 sotto sforzo), caption, lines[], metrics[], foot, procs[], offload (lavori nostri in corso) }
//   metric = { key, name, pct, level, limit, note, history[{t,v}] }

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const num = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', ',');
const gb = (g) => (g >= 100 ? `${Math.round(g)} GB` : `${num(g)} GB`);
const MAC_LIMITS = { cpu: 85, mem: 80, gpu: 80, disk: 85 };

// Il Mac su cui gira l'hub, dallo snapshot di macwatch.
export function macMachine(s, { name = 'Mac', id = 'local' } = {}) {
  const e = s && s.effort;
  if (!e) return null;
  const metrics = e.parts.filter((p) => p.pct != null).map((p) => {
    const hist = (s.history && s.history[p.key]) || [];
    const peak = Math.max(p.pct, ...hist.map((h) => h.v));
    let note = `picco ${Math.round(peak)}%`;
    if (p.key === 'cpu') note = (p.load || 0) >= 1 ? `${num(p.load)} in fila/core` : `${num((p.pct / 100) * s.cores)} di ${s.cores} core`;
    if (p.key === 'mem' && s.mem) note = `${gb(s.mem.usedGB)} di ${gb(s.mem.totalGB)}`;
    if (p.key === 'gpu') note = `picco 24 h ${Math.round(peak)}%`;
    if (p.key === 'disk' && s.disk) note = `${gb(s.disk.freeGB)} liberi`;
    return { key: p.key, name: p.key === 'mem' ? 'RAM' : cap(p.name), pct: p.pct, level: p.level, limit: MAC_LIMITS[p.key] ?? null, note, history: hist };
  });
  const lines = [];
  if (e.level > 0) lines.push((e.why ? cap(e.why) + ' · ' : '') + 'pesa di più: ' + (s.hogs || []).slice(0, 3).map((h) => `${h.name} ${h.memMB >= 1024 ? gb(h.memMB / 1024) : Math.round(h.memMB) + ' MB'}`).join(', '));
  if ((s.paused || []).length) lines.push('In pausa finché respira: ' + s.paused.map((p) => p.label).join(', '));
  let foot = null;
  if (s.mem) {
    const pres = e.parts.find((p) => p.key === 'mem')?.pct, g = e.parts.find((p) => p.key === 'gpu')?.pct;
    foot = `RAM: app ${gb(s.mem.appGB)} · wired ${gb(s.mem.wiredGB)} · compressa ${gb(s.mem.compressedGB)} · cache ${gb(s.mem.cachedGB)} · libera ${gb(s.mem.freeGB)}\n`
      + (pres != null ? `pressione ${pres}% · ` : '') + `swap ${gb(s.swapUsedGB || 0)} di ${gb(s.swapTotalGB || 0)}` + (s.swapSustained ? ', rilegge da disco' : '') + (g != null ? ` · GPU ${g}% adesso` : '');
  }
  return { id, name, local: true, state: e.label, level: e.level, caption: `${s.cores} core · ultime 24 h`, lines, metrics, foot, procs: [], offload: 0 };
}

// Un PC letto da pc-state: {pc: dorme|acceso|lavora|sconosciuto, perche, mac, soglia, avviso}. Il «perché» di un PC che lavora
// è la riga di wf-autosleep («processo X a N core; cpu N%; gpu N%; …»): se ne tirano fuori le misure e chi gira.
// Lavori che offload sta facendo girare sul PC adesso: un file per giro in ~/.cache/offload/running,
// scritto da offload prima del comando e tolto a fine giro. Un file con il pid morto (kill -9) non conta.
export function offloadJobs({ dir = path.join(os.homedir(), '.cache', 'offload', 'running'), alive = pidAlive } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const jobs = [];
  for (const f of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && Number.isFinite(j.pid) && alive(j.pid)) jobs.push(j);
    } catch { /* file a metà scrittura: al giro dopo */ }
  }
  return jobs.sort((a, b) => a.at - b.at);
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// Il comando in parole: «i test di usage-hub», «la build di quadra»; il resto com'è, accorciato.
export function jobText(j) {
  const c = String(j.cmd || '').trim(), d = j.dir || '';
  const what = /playwright|e2e/i.test(c) ? 'i test nel browser' : /\btest\b|vitest|jest|pytest/i.test(c) ? 'i test'
    : /\bbuild\b|tsc\b|cargo build|make\b/i.test(c) ? 'la build' : null;
  return what ? `${what}${d ? ' di ' + d : ''}` : (c.length > 40 ? c.slice(0, 39) + '…' : c) + (d ? ` (${d})` : '');
}

export function pcMachine(p, { name = 'PC', id = 'pc', jobs = [], now = Date.now() } = {}) {
  if (!p || !p.pc) return null;
  const why = p.perche || '';
  const metrics = [];
  // stesse soglie del Mac: impegnato / sotto sforzo
  for (const [key, label, limit, hard] of [['cpu', 'CPU', 85, 97], ['gpu', 'GPU', 80, 95]]) {
    const m = why.match(new RegExp(`\\b${key}\\s+(\\d+)%`, 'i'));
    if (!m) continue;
    const pct = Number(m[1]);
    metrics.push({ key, name: label, pct, level: pct >= hard ? 2 : pct >= limit ? 1 : 0, limit, note: 'adesso', history: [] });
  }
  const procs = [...why.matchAll(/processo\s+(\S+)\s+a\s+([\d.,]+)\s+core/gi)].map((m) => ({ name: m[1], cores: Number(m[2].replace(',', '.')) }));
  const words = { dorme: 'dorme', acceso: 'acceso', lavora: 'lavora', sconosciuto: 'non risponde' };
  const lines = [];
  // prima cosa sta facendo per noi: cosa, da quanto, per chi
  for (const j of jobs) {
    const mins = Math.max(0, Math.round((now - j.at) / 60000));
    lines.push(`Sta lavorando: ${jobText(j)} · da ${mins < 1 ? 'meno di 1 min' : mins + ' min'} · per ${j.who || 'terminale'}`);
  }
  if (procs.length) lines.push('Ci gira: ' + procs.map((x) => `${x.name} a ${num(x.cores)} core`).join(', '));
  if (p.pc === 'acceso' && why) lines.push(cap(why));
  if (p.pc === 'sconosciuto' && why) lines.push(cap(why));
  if (p.avviso) lines.push(`Il Mac è a ${num(p.mac)} per core (soglia ${num(p.soglia)}) e questa macchina dorme: suite e build vanno con offload, che la sveglia`);
  const level = p.avviso ? 1 : Math.max(0, ...metrics.map((m) => m.level));
  const caption = p.pc === 'dorme' ? 'si sveglia da sola con offload' : p.pc === 'sconosciuto' ? 'stato non letto' : 'dorme dopo 20 min senza lavoro';
  // offload attivo = sta lavorando per noi, anche se pc-state non l'ha ancora visto (legge una volta al minuto)
  const state = jobs.length ? 'lavora' : words[p.pc] || p.pc;
  return { id, name, local: false, state, level, caption, lines, metrics, foot: null, procs, offload: jobs.length };
}
