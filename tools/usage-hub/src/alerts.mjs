// Regole di avviso a soglia: ognuna scatta una volta per settimana, poi tace fino al reset.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const WEEK_MS = 7 * 86400000;

function formatPct(value) {
  return new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(value);
}

function musePaceAlert(report) {
  const quota = report.muse?.quota;
  const used = quota?.weekPct;
  const resetAt = quota?.weekResetsAt;
  if (!Number.isFinite(used) || !Number.isFinite(resetAt)) return null;
  const now = Number.isFinite(report.at) ? report.at : Date.now();
  const elapsedFraction = (now - (resetAt - WEEK_MS)) / WEEK_MS;
  const expectedPct = elapsedFraction * 100;
  const threshold = expectedPct * 1.3 + 5;
  if (used <= threshold) return null;
  const resetTime = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(resetAt));
  const projects = [...(report.muse.projects || [])]
    .sort((a, b) => (b.share || 0) - (a.share || 0))
    .slice(0, 3)
    .map((p) => ({ name: p.name, share: p.share || 0 }));
  const projectText = projects.length
    ? projects.map((p) => `${p.name} ${formatPct(p.share * 100)}%`).join(', ')
    : 'nessun dato';
  const shownExpected = Math.round(expectedPct * 10) / 10;
  return {
    id: 'muse:pace',
    subject: 'Muse pace',
    value: used,
    expectedPct: shownExpected,
    threshold,
    week: resetAt,
    resetAt,
    projects,
    message: `Ritmo Muse: usato ${formatPct(used)}%, atteso ${formatPct(shownExpected)}%; reset ${resetTime}. Progetti principali: ${projectText}.`,
  };
}

// Ritmo di ogni abbonamento (report.pace da src/pacing.mjs): un avviso a settimana per account
// quando finisce con più di un giorno di anticipo. Muse ha già il suo.
// Il «consuma N volte il ritmo» non avvisa più (24/10): 25 messaggi su 32 in una settimana, e sopra quel ritmo
// il gate di delegate sposta già da solo il lavoro differibile sul gratis. Il ritmo resta nell'hub e nella tray.
export function paceAlerts(report) {
  const out = [];
  for (const r of report.pace || []) {
    if (r.provider === 'muse') continue;
    const daysEarly = (r.resetsAt - (report.at || Date.now())) / 86400000;
    const reset = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(r.resetsAt));
    if (r.status === 'esaurito' && daysEarly > 1) {
      out.push({ id: `empty:${r.provider}/${r.account}`, subject: `${r.provider} esaurito`, value: r.used, threshold: 100, week: r.resetsAt,
        message: `${r.provider} (${r.account}) è esaurito con ${formatPct(daysEarly)} giorni d'anticipo, torna ${reset}.` });
    }
  }
  return out;
}

export function evaluateRules(report, rules = []) {
  const events = [];
  for (const r of rules) {
    let value;
    let subject;
    let week = report.account.weekResetsAt;
    if (r.scope === 'project') {
      const p = report.projects.find((x) => x.name === r.project);
      value = p ? p.weekPct : 0;
      subject = r.project;
    } else if (r.scope === 'muse') {
      // Quota Muse 7d dalla tray: senza quota letta la regola tace.
      value = report.muse && report.muse.quota ? report.muse.quota.weekPct : null;
      subject = 'muse 7d';
      if (value != null && report.muse.quota.weekResetsAt) week = report.muse.quota.weekResetsAt;
    } else if (r.metric === '5h') {
      value = report.account.fiveHourPct;
      subject = 'account 5h';
    } else {
      value = report.account.weekPct;
      subject = 'account 7d';
    }
    if (value == null || !Number.isFinite(r.threshold) || value <= r.threshold) continue;
    events.push({
      id: r.id || `${r.scope}:${r.project || r.metric || '7d'}`,
      subject,
      value,
      threshold: r.threshold,
      week,
      message: (r.message || '{subject} at {value}% (threshold {threshold}%)')
        .replace('{subject}', subject)
        .replace('{value}', value)
        .replace('{threshold}', r.threshold),
    });
  }
  const pace = musePaceAlert(report);
  if (pace) events.push(pace);
  events.push(...paceAlerts(report));
  return events;
}

export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Tace finché il reset memorizzato all'invio non è passato (il resetsAt di Codex oscilla di secondi/minuti a ogni lettura, quindi il confronto esatto non vale).
export function filterNew(events, state, report) {
  const now = Number.isFinite(report?.at) ? report.at : Date.now();
  return events.filter((e) => !(typeof state[e.id] === 'number' && now < state[e.id]));
}

export function markSent(events, state, report) {
  for (const e of events) {
    state[e.id] = e.subject === 'account 5h' ? report.account.fiveHourResetsAt : e.week;
  }
  return state;
}

// Esegue il comando configurato (evento JSON su stdin) e/o chiama il webhook.
export async function notify(event, notifyCfg = {}, fetchImpl = fetch) {
  const jobs = [];
  if (notifyCfg.command) {
    jobs.push(new Promise((resolve, reject) => {
      const child = spawn(notifyCfg.command, {
        shell: true,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, USAGE_HUB_MESSAGE: event.message, USAGE_HUB_ID: event.id, USAGE_HUB_VALUE: String(event.value) },
      });
      child.on('error', reject);
      child.on('close', (code) => (code ? reject(new Error(`notify command exited ${code}`)) : resolve()));
      child.stdin.end(JSON.stringify(event));
    }));
  }
  if (notifyCfg.webhook) {
    jobs.push(fetchImpl(notifyCfg.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10000),
    }));
  }
  await Promise.all(jobs);
}

export async function runAlerts(report, config, { dryRun = false, fetchImpl = fetch } = {}) {
  const stateFile = config.stateFile;
  const state = stateFile ? loadState(stateFile) : {};
  const fresh = filterNew(evaluateRules(report, config.alerts?.rules), state, report);
  if (dryRun) return fresh;
  for (const e of fresh) await notify(e, config.alerts?.notify, fetchImpl);
  if (stateFile && fresh.length) fs.writeFileSync(stateFile, JSON.stringify(markSent(fresh, state, report)));
  return fresh;
}
