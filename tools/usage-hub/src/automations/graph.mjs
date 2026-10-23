// Schema a passi di un'automazione, ricavato dalla sua definizione vera e dal suo ultimo giro.
// Fonti: il job nel sqlite di OpenClaw (orario, prompt, comando, canale), lo script che lancia
// (chi esegue, in ordine di riga, con i ripieghi) e il log dello script (chi ha fallito, quando).
// Niente scritto a mano: un passo che la definizione non nomina qui non c'è.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { whenOf, tilde } from './describe.mjs';

const HOME = os.homedir();
const expand = (p) => String(p || '').replace(/^~(?=\/|$)/, HOME).replace(/\$HOME|\$\{HOME\}/g, HOME);
const read = (p) => { try { return fs.readFileSync(expand(p), 'utf8'); } catch { return null; } };

const EXEC = { muse: 'Muse', claude: 'Claude', codex: 'Codex' };
// Esecutore di un riferimento modello di OpenClaw («anthropic/claude-sonnet-5-5», «muse-cli/muse-spark-1.3»).
function execOfRef(ref) {
  const r = String(ref || '');
  if (/muse/.test(r)) return 'muse';
  if (/openai|codex|gpt/.test(r)) return 'codex';
  if (/claude|anthropic/.test(r)) return 'claude';
  return null;
}
const modelName = (ref) => String(ref || '').split('/').pop();

// Comandi personali (~/bin, ~/.local/bin): un passo dello script li chiama per nome.
let binCache = null;
function homeBins() {
  if (binCache) return binCache;
  binCache = new Set();
  for (const d of ['bin', '.local/bin']) {
    try { for (const f of fs.readdirSync(path.join(HOME, d))) binCache.add(f); } catch { /* cartella assente */ }
  }
  for (const x of ['muse', 'claude', 'codex', 'node', 'python3', 'curl', 'perl', 'git']) binCache.delete(x);
  return binCache;
}

// Il commento sopra un comando dice a cosa serve: la prima frase.
function commentAbove(lines, i) {
  for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
    const t = lines[k].trim();
    if (!t.startsWith('#')) { if (t) break; continue; }
    const s = t.replace(/^#+\s*/, '').split(/[;(.]|—| - /)[0].trim();
    // Intero: la vista va a capo, un commento troncato non si legge più.
    if (s && !/^!/.test(s)) return s;
  }
  const v = /^(\w+)=\$\(/.exec(lines[i].trim());
  return v ? v[1] : null;
}

// Passi di uno script bash, in ordine di riga. I modelli in sequenza con `used=` sono ripieghi:
// lo script prova il primo e passa al successivo solo se fallisce.
export function parseScript(text, bins = homeBins()) {
  const lines = String(text || '').split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^\w+\(\)\s*\{/.test(t) && !/\b(muse exec|claude -p|codex exec)\b/.test(t)) continue; // definizione di funzione
    let m;
    if ((m = /\bmuse exec\b.*?--model\s+(\S+)/.exec(t))) steps.push({ line: i + 1, kind: 'model', exec: 'muse', model: m[1] });
    else if ((m = /\bclaude -p\b.*?--model\s+(\S+)/.exec(t))) steps.push({ line: i + 1, kind: 'model', exec: 'claude', model: m[1] });
    else if ((m = /\bcodex exec\b.*?\s-m\s+(\S+)/.exec(t))) steps.push({ line: i + 1, kind: 'model', exec: 'codex', model: m[1] });
    else if ((m = /\bcurl\b[^|]*?https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)(\/[^\s"'|)]*)/.exec(t))) {
      const last = steps[steps.length - 1];
      // una chiamata sulla riga subito dopo un'altra, senza commento in mezzo, è lo stesso passo
      if (last && last.kind === 'call' && last.line === i) { last.detail += ' + :' + m[1] + m[2]; last.line = i + 1; continue; }
      const label = commentAbove(lines, i);
      steps.push({ line: i + 1, kind: 'call', label: label || 'chiamata locale ' + m[2], detail: ':' + m[1] + m[2] });
    } else if ((m = /\bnode\s+"?([^"\s]+\.m?js)"?\s+(\w+)/.exec(t))) {
      steps.push({ line: i + 1, kind: 'tool', label: commentAbove(lines, i) || path.basename(m[1]) + ' ' + m[2], detail: tilde(expand(m[1])) + ' ' + m[2] });
    } else {
      const words = t.replace(/["'$(){}|;&]/g, ' ').split(/\s+/);
      const hit = words.find((w) => bins.has(w));
      if (hit && !/^log\b/.test(t)) steps.push({ line: i + 1, kind: 'tool', label: commentAbove(lines, i) || hit, detail: hit });
    }
  }
  const chain = /\bused=/.test(text) && steps.filter((s) => s.kind === 'model').length > 1;
  const errlog = (/^ERRLOG="?([^"\n]+)"?/m.exec(text) || [])[1] || null;
  const tag = (/echo "[^"]*?\b([\w-]+): \$\*"/.exec(text) || [])[1] || null;
  return { steps, chain, errlog: errlog && expand(errlog), tag };
}

// Fonti che il prompt chiede di leggere: comandi tra backtick e file sotto ~.
const TRIVIAL = new Set(['date', 'echo', 'ls', 'cat', 'pwd', 'true']);
export function extractSources(prompt) {
  const text = String(prompt || '');
  const out = [];
  const seen = new Set();
  const add = (label, detail, write) => { if (!seen.has(label)) { seen.add(label); out.push({ label, detail, write: !!write }); } };
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const cmd = m[1].trim();
    if (/^~?\//.test(cmd)) continue;
    const w = cmd.split(/\s+/);
    if (TRIVIAL.has(w[0]) || !/^[a-z][\w-]+$/.test(w[0])) continue;
    add(w[0] === 'gws-mail' || w[0] === 'gws' ? w.slice(0, 3).join(' ') : w[0], cmd);
  }
  for (const m of text.matchAll(/~\/[\w.\-/]+(?:<[^>\n]*>[\w.\-]*)?/g)) {
    let p = m[0].replace(/[.,]$/, '');
    if (p.includes('<')) p = p.slice(0, p.indexOf('<'));
    const label = p.endsWith('/') ? path.basename(p) + '/' : path.basename(p);
    const before = text.slice(Math.max(0, m.index - 50), m.index).toLowerCase();
    add(label, p, /scriv|sovrascriv|salva in/.test(before));
  }
  return out;
}

// Righe del log dello script nel giro: chi ha fallito, chi è stato saltato, chi ha chiuso.
export function runEvents(logText, tag, start, end) {
  if (!logText || !tag || start == null) return [];
  const ev = [];
  const re = new RegExp('^(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d) ' + tag.replace(/[-]/g, '\\-') + ': (.*)$', 'gm');
  for (const m of logText.matchAll(re)) {
    const at = new Date(m[1].replace(' ', 'T')).getTime(); // ora locale, come la scrive `date`
    if (at < start - 2000 || at > (end ?? start) + 60000) continue;
    const msg = m[2];
    let r;
    if ((r = /^(?:anche )?(muse|claude|codex) fallit\w*:?\s*(.*)$/i.exec(msg))) ev.push({ at, exec: r[1].toLowerCase(), kind: 'error', text: r[2] || msg });
    else if ((r = /^salto (muse|claude|codex):?\s*(.*)$/i.exec(msg))) ev.push({ at, exec: r[1].toLowerCase(), kind: 'skipped', text: r[2] });
    else if ((r = /fatto con (muse|claude|codex)/i.exec(msg))) ev.push({ at, exec: r[1].toLowerCase(), kind: 'ok', text: msg });
  }
  return ev;
}

// Esito di ogni esecutore della catena di ripiego nell'ultimo giro.
function chainOutcomes(models, events, run) {
  let prev = run.at;
  let done = false;
  return models.map((s) => {
    const e = events.find((x) => x.exec === s.exec);
    let outcome = null, ms = null, note = null;
    if (done) outcome = 'unused';
    else if (e) {
      outcome = e.kind; note = e.text || null;
      ms = prev != null ? e.at - prev : null; prev = e.at;
      if (e.kind === 'ok') done = true;
    } else if (run.outcome === 'ok') {
      outcome = 'ok'; done = true;
      ms = prev != null && run.end != null ? run.end - prev : null;
    }
    return { ...s, outcome, ms, note };
  });
}

function triggerNode(job) {
  return { id: 'trigger', kind: 'trigger', label: whenOf(job.schedule), detail: 'cron OpenClaw ' + job.name };
}
function deliverNode(job, card, run) {
  const d = job.delivery || {};
  if (!d.channel || d.mode === 'none') return null;
  const del = card?.last?.delivered;
  return {
    id: 'deliver', kind: 'deliver', label: d.channel === 'whatsapp' ? 'WhatsApp' : d.channel === 'last' ? "ultima chat" : d.channel,
    detail: d.mode === 'announce' ? 'OpenClaw consegna il testo' : d.mode,
    outcome: del === 'delivered' ? 'ok' : del === 'failed' ? 'error' : run.outcome === 'ok' ? null : run.outcome,
    at: run.end, error: run.deliveryError || null,
  };
}

// Grafo di un job di OpenClaw.
const clip = (t, n = 6000) => { const x = String(t ?? '').trim(); return !x ? null : x.length > n ? x.slice(0, n) + '\n…' : x; };

export function graphForJob(job, run, card = null) {
  const nodes = [triggerNode(job)];
  const from = ['cron OpenClaw «' + job.name + '»'];
  const p = job.payload || {};
  let prompt = p.input || p.message || '';
  // Un prompt che rimanda a un file: le fonti stanno lì.
  const ref = /~\/[\w.\-/]+\.md/.exec(prompt);
  if (ref && prompt.length < 400) { const t = read(ref[0]); if (t) { prompt += '\n' + t; from.push(ref[0]); } }
  const all = extractSources(prompt);
  const sources = all.filter((x) => !x.write);
  const writes = all.filter((x) => x.write);
  if (sources.length) nodes.push({ id: 'sources', kind: 'sources', label: sources.length === 1 ? '1 fonte' : sources.length + ' fonti', items: sources, detail: 'nominate nel prompt' });

  if (p.kind === 'command') {
    const script = (p.argv || []).find((a) => /\.(sh|bash)$/.test(a));
    const text = script && read(script);
    if (text) {
      from.push(tilde(script));
      const sc = parseScript(text);
      const events = sc.errlog ? runEvents(read(sc.errlog), sc.tag, run.at, run.end) : [];
      if (sc.errlog && events.length) from.push(tilde(sc.errlog));
      const models = sc.steps.filter((s) => s.kind === 'model');
      const firstModel = sc.steps.indexOf(models[0]);
      const lastModel = sc.steps.indexOf(models[models.length - 1]);
      const pre = firstModel < 0 ? sc.steps : sc.steps.slice(0, firstModel).filter((s) => s.kind !== 'model');
      const mid = firstModel < 0 ? [] : sc.steps.slice(firstModel, lastModel + 1).filter((s) => s.kind !== 'model');
      const post = firstModel < 0 ? [] : sc.steps.slice(lastModel + 1);
      const stepNode = (s, i, where) => ({ id: where + i, kind: 'step', label: s.label, detail: s.detail, outcome: run.outcome === 'ok' ? 'ok' : null, inferred: true });
      pre.forEach((s, i) => nodes.push(stepNode(s, i, 'pre')));
      if (models.length) {
        const opts = chainOutcomes(models, events, run).map((s) => ({ exec: s.exec, name: EXEC[s.exec], model: s.model, outcome: s.outcome, ms: s.ms, note: s.note, tokens: null }));
        nodes.push({ id: 'model', kind: 'model', label: sc.chain ? 'Modello, con ripiego' : 'Modello', options: opts, gates: mid.map((s) => s.label),
          io: { in: clip(p.input), out: clip(run.output), outFrom: 'testo del giro registrato da OpenClaw' },
          ms: opts.reduce((n, o) => n + (o.ms || 0), 0) || null });
      }
      post.forEach((s, i) => nodes.push(stepNode(s, i, 'post')));
    } else {
      nodes.push({ id: 'cmd', kind: 'step', label: path.basename((p.argv || [])[1] || (p.argv || [])[0] || 'comando'), detail: (p.argv || []).map(tilde).join(' '), outcome: run.outcome });
    }
  } else if (p.kind === 'agentTurn') {
    const refs = [p.model, ...(p.fallbacks || [])].filter(Boolean);
    const opts = refs.map((r, i) => ({ exec: execOfRef(r), name: EXEC[execOfRef(r)] || modelName(r), model: modelName(r), account: r.split('/')[0], outcome: i === 0 ? run.outcome : null, ms: i === 0 && run.end != null && run.at != null ? run.end - run.at : null, tokens: null }));
    if (!opts.length) opts.push({ exec: null, name: 'agente ' + (job.agentId || 'main'), model: null, outcome: run.outcome, ms: null, tokens: null });
    nodes.push({ id: 'model', kind: 'model', label: refs.length > 1 ? 'Modello, con ripiego' : 'Modello', options: opts, note: refs.length > 1 ? 'OpenClaw non registra quale ha risposto' : null,
      io: { in: clip(p.message), out: clip(run.output), outFrom: 'testo del giro registrato da OpenClaw' }, ms: run.ms ?? null });
  } else {
    return null; // heartbeat e simili: niente passi
  }
  writes.forEach((w, i) => nodes.push({ id: 'write' + i, kind: 'step', label: 'scrive ' + w.label, detail: w.detail, outcome: run.outcome === 'ok' ? 'ok' : null, inferred: true }));
  const dn = deliverNode(job, card, run);
  if (dn) nodes.push(dn);
  return { key: 'cron:' + job.id, title: card?.title || job.displayName || job.name, run, nodes, from };
}

// Grafo di un job letto dal sqlite di OpenClaw, per chiave «cron:<id>».
export function graphForCron(key, { db = '~/.openclaw/state/openclaw.sqlite', card = null } = {}) {
  const id = key.slice('cron:'.length);
  let sql;
  try {
    sql = new DatabaseSync(expand(db), { readOnly: true });
    const row = sql.prepare('select job_id, name, job_json, state_json from cron_jobs where job_id = ?').get(id);
    if (!row) return null;
    const job = { id: row.job_id, name: row.name, ...JSON.parse(row.job_json) };
    const state = JSON.parse(row.state_json || '{}');
    const rec = sql.prepare('select status, started_at_ms, finished_at_ms from cron_run_receipts where job_id = ? order by started_at_ms desc limit 1').get(id);
    const at = state.lastRunAtMs ?? rec?.started_at_ms ?? null;
    const run = {
      at, end: rec && rec.started_at_ms === at ? rec.finished_at_ms : (at != null && state.lastDurationMs != null ? at + state.lastDurationMs : null),
      ms: state.lastDurationMs ?? (rec ? rec.finished_at_ms - rec.started_at_ms : null),
      outcome: state.lastRunStatus === 'interrupted' ? 'error' : (state.lastRunStatus ?? rec?.status ?? null),
      output: state.lastDiagnostics?.summary ?? null,
      deliveryError: state.lastDeliveryError ?? null,
    };
    return graphForJob(job, run, card);
  } catch {
    return null;
  } finally {
    try { sql?.close(); } catch { /* già chiuso */ }
  }
}

// Grafo di un job launchd che lancia uno script: niente log per giro, solo la forma.
export function graphForLaunchd(card) {
  const cmd = card?.tech?.command || '';
  const script = cmd.split(/\s+/).find((a) => /\.(sh|bash)$/.test(a));
  const text = script && read(script);
  if (!text) return null;
  const sc = parseScript(text);
  if (sc.steps.length < 2) return null;
  const run = { at: card.last?.at ?? null, end: null, ms: null, outcome: card.last?.outcome ?? null };
  const nodes = [{ id: 'trigger', kind: 'trigger', label: card.when || '—', detail: 'launchd' }];
  sc.steps.forEach((s, i) => nodes.push(s.kind === 'model'
    ? { id: 'm' + i, kind: 'model', label: 'Modello', options: [{ exec: s.exec, name: EXEC[s.exec], model: s.model, outcome: null, ms: null, tokens: null }] }
    : { id: 's' + i, kind: 'step', label: s.label, detail: s.detail, outcome: null }));
  return { key: card.key, title: card.title, run, nodes, from: [tilde(script)] };
}

// Grafo di un workflow Lobster: i suoi passi come li registra Lobster.
export function graphForSteps(card) {
  const steps = card?.steps || [];
  if (!steps.length) return null;
  const run = { at: card.last?.at ?? null, end: null, ms: null, outcome: card.last?.outcome ?? null };
  return {
    key: card.key, title: card.title, run, from: ['workflow Lobster «' + (card.tech?.label || card.title) + '»'],
    nodes: [{ id: 'trigger', kind: 'trigger', label: card.when || 'a mano', detail: card.who || '' }].concat(steps.map((s, i) => ({
      id: 's' + i, kind: s.executor ? 'model' : 'step', label: s.label || s.id, detail: s.model || '',
      outcome: s.outcome ?? null, tokens: s.tokens ?? null,
      options: s.executor ? [{ exec: s.executor, name: EXEC[s.executor] || s.executor, model: s.model, outcome: s.outcome ?? null, ms: null, tokens: s.tokens ?? null }] : undefined,
    }))),
  };
}

export function graphFor(key, { card = null, db } = {}) {
  if (key.startsWith('cron:')) return graphForCron(key, { card, db });
  if (key.startsWith('launchd:')) return graphForLaunchd(card);
  if (card?.steps?.length) return graphForSteps(card);
  return null;
}
