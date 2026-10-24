// Agenti vivi adesso, per progetto: sessioni Claude, Codex, Muse (transcript toccati negli ultimi minuti) e lavori
// della coda in corso. Solo stat() e la coda del file: costa decine di ms, il server la rinfresca ogni ~45 s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectName } from './usage.mjs';
import { listDir } from './dirs.mjs';

const MIN = 60000;
export const ACTIVE_MS = 5 * MIN;

export function modelLabel(id = '') {
  if (/opus/i.test(id)) return 'Opus';
  if (/sonnet/i.test(id)) return 'Sonnet';
  if (/haiku/i.test(id)) return 'Haiku';
  if (/fable/i.test(id)) return 'Fable';
  if (/muse/i.test(id)) return 'Muse';
  if (/gpt|codex|luna|^o\d/i.test(id)) return 'GPT';
  return id || '?';
}

function readSlice(file, from, len) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, from); return b.toString('utf8', 0, n); } finally { fs.closeSync(fd); }
}
const head = (file, st, n = 65536) => readSlice(file, 0, Math.min(n, st.size));
// Cartella, modello, titolo e inizio stanno nelle prime righe e non cambiano più: si leggono a passi (16 KB, poi fino a max
// solo se manca qualcosa) e una volta sola per file. Prima ogni /api/live rileggeva 64-256 KB di migliaia di sessioni Codex
// e Muse: 800 MB di stringhe per chiamata e il hub a 900 MB di memoria.
// La cartella serve per tutte le sessioni della settimana, il resto solo per le poche attive: due memo, così una sessione
// ferma costa al massimo una lettura da 16 KB (di più solo se la cartella non c'è ancora), una volta nella vita.
const cwdMemo = new Map(), headMemo = new Map();
// Cerca la chiave nei byte di un buffer unico riusato: niente stringhe da 16-64 KB per file solo per trovare una cartella.
const scratch = Buffer.allocUnsafe(262144);
function cwdOfFile(file, st, key, max) {
  if (cwdMemo.has(file)) return cwdMemo.get(file);
  const needle = Buffer.from('"' + key + '":"');
  let cwd = '';
  const fd = fs.openSync(file, 'r');
  try {
    for (const n of [16384, max]) {
      const len = fs.readSync(fd, scratch, 0, Math.min(n, max, st.size), 0);
      const k = scratch.subarray(0, len).indexOf(needle);
      if (k >= 0) { const from = k + needle.length, to = scratch.indexOf(34, from); if (to > from && to < len) cwd = scratch.toString('utf8', from, to); break; }
      if (n >= st.size) break;
    }
  } catch { /* file sparito tra stat e open */ } finally { fs.closeSync(fd); }
  cwdMemo.set(file, cwd);
  return cwd;
}
function headInfo(file, st, max, pick) {
  if (!headMemo.has(file)) headMemo.set(file, pick(head(file, st, max)));
  return headMemo.get(file);
}
const tail = (file, st, n = 131072) => { const len = Math.min(n, st.size); return readSlice(file, st.size - len, len); };
const lastMatch = (text, re) => { let m, last = null; const g = new RegExp(re.source, 'g'); while ((m = g.exec(text))) last = m; return last; };
// Inizio dell'ultimo tratto di lavoro continuo (buchi sotto i 30 min) letto nella coda del file: una sessione ripresa dopo giorni non è "viva da 5 giorni".
export function runStart(text, fallback) {
  const ts = [...text.matchAll(/"timestamp":"([^"]+)"/g)].map((m) => Date.parse(m[1])).filter(Boolean);
  if (!ts.length) return fallback;
  let start = ts[ts.length - 1];
  for (let i = ts.length - 2; i >= 0; i--) { if (start - ts[i] > 30 * MIN) break; start = Math.min(start, ts[i]); }
  return start;
}
// Il titolo è il primo messaggio quando manca aiTitle: il contesto iniettato dagli harness (ambiente Claude Code,
// intestazione OpenClaw) non è un titolo e da lì in poi si taglia tutto.
export const clip = (s, n = 240) => { s = s.replace(/(#\s*Environment\b|:?\s*-\s*Primary working directory|Conversation info:\s*(\[|⟦)openclaw:ctx)[\s\S]*$/, '').replace(/\\n|\\t/g, ' ').replace(/\[[^\]]*GMT[^\]]*\]|<<<[^>]*>>>|<\/?[a-z-]+>|# Environment You have been invoked in the following environm\w*|\[Subagent Context\]|You are running as a subagent \([^)]*\)\.?|Complete the current \[Subagent Task\][^:]*:?|Conversation info: \[openclaw:ctx\]/g, ' ').replace(/\s+/g, ' ').trim();
  // promemoria iniettati dall'app (sessioni collegate, sessione nata da un'altra) non sono un titolo: dopo i tag tolti
  if (/^(Linked sessions now \(status, not an instruction\)|Background \(from the session that started this one\))/.test(s)) s = '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Il lavoro in parole per la tray: il titolo senza id, percorsi, comandi né preamboli dell'harness, prima frase sola.
// «[cron:<id> nome] Esegui…» → «Esegui…», «TASK (spec…) Scrivi…» → «Scrivi…», «diag:freni» → «Diagnosi: freni».
const STEP = { fix: 'Correzione', fix2: 'Correzione', diag: 'Diagnosi', verifica: 'Verifica', misura: 'Misura', review: 'Revisione', test: 'Test' };
export function workLabel(t = '', n = 60) {
  let s = String(t || '').replace(/…$/, '');
  const step = s.match(/^([a-z0-9]+):([\w.-]+)$/i);
  if (step) return `${STEP[step[1].toLowerCase()] || step[1]}: ${step[2].replace(/[-_]+/g, ' ')}`;
  s = s.replace(/\[(cron|subagent|task)[^\]]*\]/gi, ' ')
    .replace(/\([^)]*\)?/g, ' ')                                         // parentesi, anche quella tagliata dal clip
    .replace(/`[^`]*`?/g, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')         // ore e date del preambolo
    .replace(/(?<![\w/])(~|\.{1,2})?\/[^\s,;]+|\b[\w-]+\.(jsonl?|mjs|js|ts|tsx|swift|py|sh|md|ya?ml)\b/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b[0-9a-f]{12,}\b/gi, ' ')
    .replace(/\s--?[a-z][\w-]*/g, ' ')
    .replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim()
    .replace(/^(in|on|at|nel|nella|dentro)[,:]\s*/i, '')                     // «In <percorso>, applica…» senza il percorso
    .replace(/^(TASK|Compito|Task|Dalla Regia|Da Regia|Dalla sessione[^.:]*)\s*[.:,-]?\s*/i, '')
    .replace(/^Richiesta di \w+[\s,]*[:.]?\s*/i, '')
    .replace(/^(sessione (del|di|della) [^:.,]+[:.,]?\s*)/i, '');
  s = s.split(/(?<=[.!?])\s|\s[—–-]\s|;\s/)[0];
  // «Tray: verifica UI/UX» resta intero (prima dei due punti c'è un nome); «Esegui il conteggio…: lancia lo script» si ferma lì
  const colon = s.indexOf(': '); if (colon > 0 && s.slice(0, colon).split(' ').length >= 3) s = s.slice(0, colon);
  s = s.replace(/[.:,;]+$/, '').trim();
  if (s.length < 3) return '';
  s = s[0].toUpperCase() + s.slice(1);
  if (s.length > n) { const cut = s.slice(0, n - 1); s = (cut.slice(0, cut.lastIndexOf(' ')) || cut) + '…'; }
  return s;
}

// Chiave progetto allineata a quella del report (gruppi, basename del cwd); le sessioni dentro ~/.openclaw sono sottoagenti Jarvis.
export function keyFor(cwd, dirName, { groups = [], ocRoot } = {}) {
  if (ocRoot && cwd && (cwd === ocRoot || cwd.startsWith(ocRoot + path.sep))) return 'openclaw/sottoagenti';
  return projectName(dirName, cwd, groups);
}

// Dentro ~/.openclaw non tutto è sottoagente: le chat di Jarvis (WhatsApp, Discord) hanno il loro bucket
// nell'indice delle sessioni OpenClaw, lo stesso dei consumi. Solo openclaw/sub:* e gli id sconosciuti restano sottoagenti.
export function openclawBucket(project, cliId, { resolve } = {}) {
  if (project !== 'openclaw/sottoagenti' || !resolve) return project;
  let b = null; try { b = resolve(cliId); } catch { /* indice illeggibile: resta sottoagente */ }
  return b && !b.startsWith('openclaw/sub:') ? b : project;
}

const markSeen = (seen, project, at, provider, cwd) => { if (!seen[project] || at > seen[project].at) seen[project] = { at, provider, cwd }; };

function claudeSessions(root, now, opts, out, seen) {
  for (const d of listDir(root)) {
    const names = listDir(path.join(root, d)).filter((n) => n.endsWith('.jsonl'));
    for (const n of names) {
      const f = path.join(root, d, n);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (now - st.mtimeMs > opts.seenDays * 86400000) continue;
      const cwd = cwdOfFile(f, st, 'cwd', 65536);
      const project = openclawBucket(keyFor(cwd, d, opts), path.basename(n, '.jsonl'), opts);
      markSeen(seen, project, st.mtimeMs, 'claude', cwd);
      if (now - st.mtimeMs > ACTIVE_MS) continue;
      const hd = st.size ? head(f, st) : '';
      const tl = tail(f, st);
      const model = (lastMatch(tl, /"model":"([^"<]+)"/) || [])[1];
      if (!model || model === '<synthetic>') continue; // senza risposte del modello non è un agente al lavoro
      const title = (lastMatch(tl, /"aiTitle":"([^"]+)"/) || [])[1] || (hd.match(/"type":"user"[\s\S]*?"content":"([^"]{5,200})/) || [])[1] || '';
      const started = runStart(tl, st.mtimeMs);
      out.push({ kind: project === 'openclaw/sottoagenti' ? 'sottoagente' : 'sessione', provider: 'claude', model: modelLabel(model), project, cwd, cliId: path.basename(n, '.jsonl'), file: f, title: clip(title), startedAt: started, lastActivity: st.mtimeMs });
    }
    // Sottoagenti di Claude Code: <sessione>/subagents/agent-*.jsonl, e un livello in più per i workflow
    // (subagents/workflows/<wf>/). Si guardano solo le sessioni toccate da poco: la sessione madre aspetta e può non scrivere.
    if (opts.seenDays > 1) continue;   // la scansione a 7 giorni serve solo per «visto l'ultima volta»: i sottoagenti vivi no
    for (const n of names) {
      const parent = path.basename(n, '.jsonl'), sub = path.join(root, d, parent, 'subagents');
      let pst; try { pst = fs.statSync(path.join(root, d, n)); } catch { continue; }
      if (now - pst.mtimeMs > 6 * 3600000) continue;
      const cwd = cwdOfFile(path.join(root, d, n), pst, 'cwd', 65536), project = keyFor(cwd, d, opts);
      const dirs = [[sub, null], ...listDir(path.join(sub, 'workflows')).map((w) => [path.join(sub, 'workflows', w), w])];
      for (const [dir, wf] of dirs) for (const a of listDir(dir).filter((x) => x.startsWith('agent-') && x.endsWith('.jsonl'))) {
        const f = path.join(dir, a); let st; try { st = fs.statSync(f); } catch { continue; }
        if (now - st.mtimeMs > ACTIVE_MS) continue;
        let meta = {}; try { meta = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* senza meta resta il titolo vuoto */ }
        if (meta.finished) continue;
        const tl = tail(f, st), model = (lastMatch(tl, /"model":"([^"<]+)"/) || [])[1];   // 128 KB: con 32 il 6% delle letture a metà lavoro non trovava il modello
        if (!model || model === '<synthetic>') continue;
        out.push({ kind: wf ? 'workflow' : 'sottoagente', provider: 'claude', model: modelLabel(model), project, cwd, cliId: a.slice(6, -6), file: f, parent, workflow: wf, depth: wf ? 2 : 1,
          title: clip(meta.description || meta.agentType || ''), startedAt: runStart(tl, st.mtimeMs), lastActivity: st.mtimeMs });   // un sottoagente ripreso giorni dopo: conta il giro attuale, non la nascita del file
      }
    }
  }
}

function dayDirs(root, now, days = 1) {
  return Array.from({ length: days + 1 }, (_, back) => back).map((back) => { const d = new Date(now - back * 86400000); const p = (v) => String(v).padStart(2, '0'); return path.join(root, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())); });
}

function codexSessions(root, now, opts, out, seen) {
  for (const dir of dayDirs(root, now, opts.seenDays)) {
    let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch { continue; }
      const cwd = cwdOfFile(f, st, 'cwd', 65536);
      const project = keyFor(cwd, cwd ? cwd.replace(/[/.]/g, '-') : '', opts);
      markSeen(seen, project, st.mtimeMs, 'codex', cwd);
      if (now - st.mtimeMs > ACTIVE_MS) continue;
      const h = headInfo(f, st, 65536, (hd) => ({ model: (hd.match(/"model":"([^"]+)"/) || [])[1] || '', title: (hd.match(/"type":"user_message"[^}]*?"message":"([^"]{5,200})/) || [])[1] || '', ts: (hd.match(/"timestamp":"([^"]+)"/) || [])[1] || '' }));
      out.push({ kind: 'codex', provider: 'codex', model: modelLabel(h.model || 'gpt'), project, cwd, file: f, title: clip(h.title), startedAt: Date.parse(h.ts) || st.birthtimeMs, lastActivity: st.mtimeMs });
    }
  }
}

function museSessions(root, now, opts, out, seen) {
  for (const dir of dayDirs(root, now, opts.seenDays)) {
    let ids = []; try { ids = fs.readdirSync(dir); } catch { continue; }
    for (const id of ids) {
      const f = path.join(dir, id, 'session.jsonl'); let st; try { st = fs.statSync(f); } catch { continue; }
      const cwd = cwdOfFile(f, st, 'workspace_root', 262144);
      const project = keyFor(cwd, cwd ? cwd.replace(/[/.]/g, '-') : '', opts);
      markSeen(seen, project, st.mtimeMs, 'muse', cwd);
      if (now - st.mtimeMs > ACTIVE_MS) continue;
      const h = headInfo(f, st, 262144, (hd) => ({ model: (hd.match(/"model_id":"([^"]+)"/) || [])[1] || '', title: (hd.match(/"refill_blocks":\[\{[^}]*?"text":"([^"]{5,200})/) || [])[1] || '', rec: (hd.match(/"recorded_at":(\d+)/) || [])[1] || '' }));
      out.push({ kind: project === 'openclaw/sottoagenti' ? 'sottoagente' : 'museagent', provider: 'muse', model: modelLabel(h.model || 'muse'), project, cwd, file: f, title: clip(h.title), startedAt: (Number(h.rec) / 1000) || st.birthtimeMs, lastActivity: st.mtimeMs });
    }
  }
}

// → { agents: [...], lastSeen: { progetto: ms } }
export function scanAgents({ now = Date.now(), claudeRoot = path.join(os.homedir(), '.claude', 'projects'), codexRoot = path.join(os.homedir(), '.codex', 'sessions'), museRoot = path.join(os.homedir(), '.local', 'share', 'muse', 'sessions'), groups = [], ocRoot = path.join(os.homedir(), '.openclaw'), queue = [], seenDays = 1, resolve = null } = {}) {
  const agents = []; const lastSeen = {}; const opts = { groups, ocRoot, seenDays, resolve };
  claudeSessions(claudeRoot, now, opts, agents, lastSeen);
  codexSessions(codexRoot, now, opts, agents, lastSeen);
  museSessions(museRoot, now, opts, agents, lastSeen);
  for (const q of queue) if (q.status === 'running') agents.push({ kind: 'coda', provider: q.provider || 'muse', model: modelLabel(q.provider === 'claude' ? 'sonnet' : q.provider === 'codex' ? 'gpt' : 'muse'), project: q.project || '', title: clip(q.task), startedAt: q.startedAt, lastActivity: Date.now() });
  // le chiamate one-shot con cui Topics ricava il titolo di una card non sono lavoro: 40 righe «sessione» in Home il 24/10
  const real = agents.filter((a) => !/^Da questa richiesta ricava un TITOLO/i.test(a.title || ''));
  real.sort((a, b) => b.lastActivity - a.lastActivity);
  return { agents: real, lastSeen };
}

// Riassunto per progetto: conteggi per modello, avviso Opus.
export function summarize(agents, { now = Date.now(), claudePct = 0 } = {}) {
  const by = {};
  for (const a of agents) (by[a.project] ||= []).push(a);
  const out = {};
  for (const [project, list] of Object.entries(by)) {
    const models = {};
    for (const a of list) { const k = `${a.provider}|${a.model}`; models[k] = (models[k] || 0) + 1; a.work = workLabel(a.title) || null; }
    // i figli subito sotto la sessione che li ha lanciati, così le viste li rientrano senza ricostruire l'albero
    const kids = new Map(); for (const a of list) if (a.parent) kids.set(a.parent, [...(kids.get(a.parent) || []), a]);
    const roots = list.filter((a) => !a.parent || !list.some((b) => b.cliId === a.parent && !b.parent));
    // un figlio la cui madre non è viva (aspetta da più di 5 min) resta in cima, senza rientro: non sta sotto una sessione estranea
    list.splice(0, list.length, ...roots.flatMap((a) => (a.parent ? [{ ...a, depth: 0, orphan: true }] : [a, ...(kids.get(a.cliId) || []).sort((x, y) => (x.depth - y.depth) || (y.lastActivity - x.lastActivity))])));
    const opus = list.filter((a) => a.model === 'Opus');
    const longest = opus.reduce((m, a) => Math.max(m, now - a.startedAt), 0);
    out[project] = { count: list.length, models: Object.entries(models).map(([k, n]) => ({ provider: k.split('|')[0], model: k.split('|')[1], n })), opus: opus.length, opusMs: longest, list };
  }
  return out;
}

// Sessioni di Claude Code desktop: l'id del transcript (cliSessionId) → id dell'app, per aprire la sessione con un clic.
export function loadDesktopSessions(root = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'), now = Date.now(), maxAgeMs = 36 * 3600000) {
  const map = new Map();
  const walk = (dir, depth) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          if (now - fs.statSync(f).mtimeMs > maxAgeMs) continue;
          const d = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (d.cliSessionId && d.sessionId) map.set(d.cliSessionId, { id: d.sessionId, title: d.title || '' });
        } catch { /* file in scrittura */ }
      }
    }
  };
  walk(root, 0);
  return map;
}

export const desktopUrl = (id) => `claude://claude.ai/epitaxy/${id}`;
export const topicsUrl = (sessionId) => `http://127.0.0.1:13333/tab/chat/${sessionId}`;

// Più tab Topics nella stessa cartella: vale quello col titolo uguale a quello della sessione, altrimenti l'unico al lavoro; nel dubbio nessuno (meglio non aprire che aprire quello sbagliato).
export function pickTopics(a, topics) {
  const same = topics.filter((x) => x.cwd && x.cwd === a.cwd);
  if (same.length <= 1) return same[0] || null;
  const norm = (v = '') => v.toLowerCase().replace(/\s+/g, ' ').trim();
  const at = norm(a.title);
  const byTitle = same.filter((x) => { const tt = norm(x.title); return tt && at && (at.startsWith(tt) || tt.startsWith(at)); });
  if (byTitle.length === 1) return byTitle[0];
  const busy = same.filter((x) => x.busy);
  return busy.length === 1 && byTitle.length === 0 ? busy[0] : null;
}

// Dove gira ogni agente e, se esiste un modo, come aprirlo: app desktop (claude://), tab Topics (stessa cartella), altrimenti solo la spiegazione.
export function attachOpen(agents, { desktop = new Map(), topics = [] } = {}) {
  for (const a of agents) {
    const d = a.cliId && desktop.get(a.cliId);
    // il titolo che l'app dà alla sessione dice il lavoro in parole («Tray UI»), meglio del primo messaggio
    if (d) { a.open = { url: desktopUrl(d.id), via: 'Claude Code desktop' }; if (d.title) a.title = clip(d.title); continue; }
    const t = a.provider === 'claude' && a.kind === 'sessione' && pickTopics(a, topics);
    if (t) { a.open = { url: topicsUrl(t.sessionId), via: 'tab Topics' }; if (t.title && t.title !== 'chat') a.title = clip(t.title); continue; }
    a.where = a.parent ? 'sottoagente di una sessione Claude Code: si segue dalla sessione che l\'ha lanciato'
      : a.kind === 'sottoagente' ? 'gira dentro OpenClaw come sottoagente: non ha una pagina da aprire'
      : a.kind === 'coda' ? 'lavoro della coda lanciato da delegate, senza finestra'
      : a.provider === 'codex' ? 'Codex da terminale: nessuna pagina da aprire'
      : a.provider === 'muse' ? 'Muse da terminale: nessuna pagina da aprire'
      : 'Claude Code da terminale o da un altro computer: non risulta nell\'app desktop né in Topics';
  }
  return agents;
}

// Tab Topics aperti (terminali con una sessione Topics), per progetto: se un progetto ha una chat, la tray la propone.
export function topicsByProject(terminals, opts = {}) {
  const out = {};
  for (const t of terminals) {
    if (t.source !== 'topics' || !t.sessionId) continue;
    const project = keyFor(t.cwd, t.cwd ? t.cwd.replace(/[/.]/g, '-') : '', opts);
    (out[project] ||= []).push({ title: t.title || 'chat', busy: !!t.busy, url: topicsUrl(t.sessionId) });
  }
  return out;
}
