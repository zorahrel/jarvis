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
    // la RAM «occupata» è sempre quasi piena su macOS e non dice niente: conta la pressione, e lo swap accanto (24/10: «RAM 66%»
    // con lo swap a 15 su 16 GB e il Mac fermo)
    if (p.key === 'mem') note = `pressione · swap ${gb(s.swapUsedGB || 0)} di ${gb(s.swapTotalGB || 0)}` + (s.swapSustained ? ', rilegge da disco' : '');
    if (p.key === 'gpu') note = `picco 24 h ${Math.round(peak)}%`;
    if (p.key === 'disk' && s.disk) note = `${gb(s.disk.freeGB)} liberi`;
    return { key: p.key, name: p.key === 'mem' ? 'Memoria' : cap(p.name), pct: p.pct, level: p.level, limit: MAC_LIMITS[p.key] ?? null, note, history: hist };
  });
  // Lo swap come misura sua, subito dopo la memoria: rosso quando è quasi pieno e il Mac ci rilegge
  if (s.swapTotalGB > 0) {
    const pct = Math.round((s.swapUsedGB / s.swapTotalGB) * 100);
    const level = pct >= 90 && s.swapSustained ? 2 : pct >= 75 ? 1 : 0;
    const i = metrics.findIndex((m) => m.key === 'mem');
    metrics.splice(i < 0 ? metrics.length : i + 1, 0, { key: 'swap', name: 'Swap', pct, level, limit: 75, value: `${num(s.swapUsedGB)}/${Number.isInteger(s.swapTotalGB) ? s.swapTotalGB : num(s.swapTotalGB)} GB`,
      note: s.swapSustained ? 'il Mac rilegge dal disco: tutto rallenta' : 'memoria scaricata su disco', history: [] });
  }
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

// Il lavoro in parole, mai il comando: la descrizione data a offload (--cosa), sennò «i test di usage-hub»,
// «la build di quadra», «l'installazione delle dipendenze di …»; un comando che non si riconosce è «un lavoro in <cartella>».
export function jobText(j) {
  if (j.what) return String(j.what);
  const c = String(j.cmd || '').trim(), d = j.dir || '';
  const what = /playwright|e2e/i.test(c) ? 'i test nel browser' : /\btest\b|vitest|jest|pytest/i.test(c) ? 'i test'
    : /\bbuild\b|tsc\b|cargo build|make\b/i.test(c) ? 'la build'
    : /\b(npm|pnpm|yarn|bun) (i|install|ci)\b/i.test(c) ? "l'installazione delle dipendenze"
    : /\blint\b|eslint|biome/i.test(c) ? 'il controllo del codice' : null;
  return what ? `${what}${d ? ' di ' + d : ''}` : `un lavoro${d ? ' in ' + d : ''}`;
}

// Il motivo grezzo di wf-autosleep (winfleet) in frasi: «ssh attivo (2 sessioni); processo node a 2,1 core» → parole.
// CPU e GPU stanno già nelle barre, l'encoder è lo stream: non diventano righe.
const APP = { node: 'Node', python: 'Python', python3: 'Python', chrome: 'Chrome', msedge: 'Edge', code: 'VS Code', ollama: 'Ollama', pwsh: 'PowerShell', powershell: 'PowerShell', sshd: 'il collegamento dal Mac', 'llama-server': 'un modello locale', obs64: 'OBS' };
export const appName = (n = '') => { const b = String(n).split(/[\\/]/).pop().replace(/\.exe$/i, ''); return APP[b.toLowerCase()] || b; };
export function pcWhy(why = '') {
  const out = [];
  for (const part of String(why).split(/;\s*/)) {
    let m;
    if ((m = part.match(/^ssh attivo \((\d+) session/))) out.push(m[1] === '1' ? 'Collegato dal Mac' : `Collegato dal Mac (${m[1]} connessioni)`);
    else if (/^stream porta/.test(part)) out.push('Sta trasmettendo lo schermo');
    else if ((m = part.match(/^processo\s+(\S+)\s+a\s+([\d.,]+)\s+core/))) out.push(`Il programma più pesante è ${appName(m[1])}, ${m[2].replace('.', ',')} core`);
    else if ((m = part.match(/^richiesta di alimentazione:\s*(.*)/))) {
      // «[DRIVER] NVIDIA High Definition Audio (HDAUDIO\…)» → il nome del driver; «[PROCESS] \Device\…\obs64.exe» → OBS
      const raw = m[1].replace(/\s*\(.*$/, '').trim();
      const who = /^\[DRIVER\]/i.test(raw) ? `Il driver ${raw.replace(/^\[\w+\]\s*/, '')}` : appName(raw.replace(/^\[\w+\]\s*/, ''));
      out.push(`${cap(who || 'Un programma')} lo tiene sveglio`);
    }
    else if ((m = part.match(/^sospensione \(inattivo da (\d+) min/))) out.push(`Si sta addormentando: senza lavoro da ${m[1]} minuti`);
    else if ((m = part.match(/^inattivo da (\d+) min \(soglia (\d+)/))) out.push(`Senza lavoro da ${m[1]} minuti: dorme fra ${Math.max(1, m[2] - m[1])}`);
    else if ((m = part.match(/^inattivo: inizio conteggio \(soglia (\d+)/))) out.push(`Senza lavoro da poco: dorme dopo ${m[1]} minuti`);
  }
  return out;
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
    const who = j.title ? `«${j.title}»` : j.who === 'terminale' || !j.who ? 'un terminale' : j.who;
    lines.push(`${cap(jobText(j))} per ${who}, da ${mins < 1 ? 'meno di un minuto' : mins === 1 ? '1 minuto' : mins + ' minuti'}`);
  }
  // il motivo di wf-autosleep in parole; quello che non si sa tradurre non si mostra (niente testo grezzo nella card)
  if (p.pc !== 'dorme') lines.push(...pcWhy(why));
  if (p.avviso) lines.push(`Il Mac è carico (${num(p.mac)} per core, soglia ${num(p.soglia)}) e il PC dorme: test e build pesanti lo svegliano da soli`);
  const level = p.avviso ? 1 : Math.max(0, ...metrics.map((m) => m.level));
  const caption = p.pc === 'dorme' ? 'si sveglia da sola con offload' : p.pc === 'sconosciuto' ? 'stato non letto' : 'dorme dopo 20 min senza lavoro';
  // offload attivo = sta lavorando per noi, anche se pc-state non l'ha ancora visto (legge una volta al minuto)
  const state = jobs.length ? 'lavora' : words[p.pc] || p.pc;
  return { id, name, local: false, state, level, caption, lines, metrics, foot: null, procs, offload: jobs.length };
}
