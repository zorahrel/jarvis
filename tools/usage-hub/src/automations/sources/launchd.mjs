// Fonte launchd: legge i plist degli agenti e l'elenco di launchctl.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { whenOf, SHORT } from '../describe.mjs';
import { lateTolerance } from '../levels.mjs';
import { localConfig } from '../../local-config.mjs';

const DAY = 86400000;
const WEEK = 7 * DAY;

// Il safe-update, se trova OpenClaw occupato, interrompe l'update e riprova da solo: il job esce con errore ma non è rotto.
// Lo leggo dall'ultima riga del suo log: «riprovo» = rimandato; un update partito da poco senza esito = in corso.
const SAFE_UPDATE = { label: 'com.jarvis.openclaw-safe-update', log: path.join(os.homedir(), '.claude/jarvis/logs/openclaw-safe-update.log') };
export function rinviatoOInCorso(label, now, log = SAFE_UPDATE.log) {
  if (label !== SAFE_UPDATE.label) return false;
  try {
    const last = fs.readFileSync(log, 'utf8').trimEnd().split('\n').pop() || '';
    if (/riprovo/.test(last)) return true;
    return /openclaw update --yes/.test(last) && now - fs.statSync(log).mtimeMs < 30 * 60000;
  } catch { return false; }
}

// I prefissi dei lavori di un cliente stanno in local.json (launchdPrefixes), non nel codice pubblico.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LOCAL_PREFIXES = Array.isArray(localConfig().launchdPrefixes) ? localConfig().launchdPrefixes : [];
const PLIST_RE = new RegExp(`^(${['com.jarvis', 'com.armonia', 'ai.openclaw', ...LOCAL_PREFIXES].map(escapeRe).join('|')})\\..+\\.plist$`);
const SKIP_RE = /\.(bak|disabled|reconcile-)/;

const defaultPlutil = (file) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));

function parseLaunchctl(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3 || parts[2] === 'Label') continue;
    map.set(parts[2].trim(), { pid: parts[0].trim(), status: Number(parts[1]) });
  }
  return map;
}

const calList = (p) => [].concat(p.StartCalendarInterval || []);

// Giorni in parole: SHORT da describe.mjs.
function dayWords(wds) {
  const uniq = [...new Set(wds)].sort((a, b) => a - b);
  if (!uniq.length) return 'ogni giorno';
  if (uniq.join(',') === '1,2,3,4,5') return 'lun-ven';
  const names = uniq.map((d) => SHORT[d] ?? String(d));
  return names.length === 2 ? names.join(' e ') : names.join(', ');
}

const hhmm = (h, m) => `${h}:${String(m).padStart(2, '0')}`;

function calendarWhen(cal) {
  if (cal.every((c) => c.Hour == null)) {
    const mins = [...new Set(cal.map((c) => c.Minute ?? 0))];
    return mins.map((m) => `ogni ora al minuto ${m}`).join(', ');
  }
  const groups = new Map();
  for (const c of cal) {
    const k = `${c.Hour}:${c.Minute ?? 0}`;
    if (!groups.has(k)) groups.set(k, { h: c.Hour, m: c.Minute ?? 0, wds: [] });
    if (c.Weekday != null) groups.get(k).wds.push(c.Weekday);
  }
  return [...groups.values()].map((g) => `${dayWords(g.wds)} alle ${hhmm(g.h, g.m)}`).join(', ');
}

// launchd Weekday: 0 e 7 sono domenica; JS getDay: 0 è domenica.
const jsWeekday = (w) => (w === 7 ? 0 : w);

// Ultima e prossima occorrenza del calendario rispetto a now (ora locale).
function calNextPrev(cal, now) {
  let prev = null, next = null;
  const consider = (t) => {
    if (t <= now && (prev == null || t > prev)) prev = t;
    if (t > now && (next == null || t < next)) next = t;
  };
  for (const c of cal) {
    if (c.Hour == null) {
      const m = c.Minute ?? 0;
      const d = new Date(now);
      d.setSeconds(0, 0);
      d.setMinutes(m, 0, 0);
      let n = d.getTime();
      if (n <= now) n += 3600000;
      consider(n);
      consider(n - 3600000);
      continue;
    }
    const want = c.Weekday == null ? null : jsWeekday(c.Weekday);
    for (let off = -7; off <= 7; off++) {
      const d = new Date(now);
      d.setDate(d.getDate() + off);
      d.setHours(c.Hour, c.Minute ?? 0, 0, 0);
      if (want != null && d.getDay() !== want) continue;
      consider(d.getTime());
    }
  }
  return { prev, next };
}

// Occorrenze di oggi già passate.
function calTodayCount(cal, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  let n = 0;
  for (const c of cal) {
    if (c.Hour == null) {
      const m = c.Minute ?? 0;
      for (let h = 0; h < 24; h++) {
        const d = new Date(start);
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= now) n++;
      }
      continue;
    }
    const want = c.Weekday == null ? null : jsWeekday(c.Weekday);
    if (want != null && start.getDay() !== want) continue;
    const d = new Date(start);
    d.setHours(c.Hour, c.Minute ?? 0, 0, 0);
    if (d.getTime() <= now) n++;
  }
  return n;
}

function calEveryMs(cal) {
  if (cal.every((c) => c.Hour == null)) return 3600000;
  const wds = new Set(cal.map((c) => c.Weekday).filter((w) => w != null));
  if (wds.size > 0 && wds.size < 5) return WEEK;
  return DAY;
}

// Idea di Cadence: chi esegue, dagli argomenti.
function whoOfArgs(args) {
  const joined = args.join(' ').toLowerCase();
  if (joined.includes('openclaw')) return 'OpenClaw';
  if (joined.includes('claude')) return 'Claude';
  if (joined.includes('codex')) return 'Codex';
  if (joined.includes('museagent')) return 'Muse';
  const file = args.find((a) => /[\w-]+\.(sh|py|mjs|js)$/.test(a));
  return `script: ${path.basename(file || args[0] || '')}`;
}

// Un job a passi (oggi solo com.jarvis.manutenzione) scrive accanto al suo log un runs.jsonl, una riga per passo:
// {run, step, label, at, ms, outcome: ok|error|skipped, note}. Da lì vengono i passi dell'ultimo giro e lo storico dei giri.
export function readStepRuns(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const by = new Map();
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.run || !e.step) continue;
    if (!by.has(e.run)) by.set(e.run, []);
    by.get(e.run).push(e);
  }
  if (!by.size) return null;
  const runs = [...by.values()].map((rows) => ({
    at: Math.min(...rows.map((r) => r.at || Infinity)),
    outcome: rows.some((r) => r.outcome === 'error') ? 'error' : 'ok',
    rows,
  })).sort((a, b) => b.at - a.at);
  const steps = runs[0].rows.map((r) => ({ id: r.step, label: r.label || r.step, executor: null, model: null, tokens: null, costUsd: null,
    outcome: r.outcome, durationMs: r.ms ?? null, note: r.note || null }));
  return { runs, steps };
}

export function readLaunchd({ dir = path.join(os.homedir(), 'Library/LaunchAgents'), launchctlList = null, now = Date.now(), plutil = defaultPlutil } = {}) {
  try {
    const text = launchctlList ?? execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    const loaded = parseLaunchctl(text);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const midnightMs = midnight.getTime();
    let services = 0;
    const items = [];
    for (const f of fs.readdirSync(dir)) {
      if (!PLIST_RE.test(f) || SKIP_RE.test(f)) continue;
      const p = plutil(path.join(dir, f));
      const label = p.Label || f.replace(/\.plist$/, '');
      if (p.KeepAlive) { services++; continue; } // resta nella scheda Servizi
      const cal = calList(p);
      if (!p.StartInterval && !cal.length && !p.WatchPaths) continue;
      const entry = loaded.get(label);
      const enabled = entry != null;
      const everyMs = p.StartInterval ? p.StartInterval * 1000
        : cal.length ? calEveryMs(cal) : null; // solo WatchPaths
      let when;
      if (p.StartInterval) when = whenOf({ kind: 'every', everyMs: p.StartInterval * 1000 });
      else if (cal.length && !p.WatchPaths) when = calendarWhen(cal);
      else if (p.WatchPaths) when = 'quando cambia una cartella' + (cal.length ? `, ${calendarWhen(cal)}` : '');
      let lastAt = null;
      for (const log of [p.StandardOutPath, p.StandardErrorPath]) {
        if (!log) continue;
        try {
          if (!fs.existsSync(log)) continue;
          const m = fs.statSync(log).mtimeMs;
          if (lastAt == null || m > lastAt) lastAt = m;
        } catch { /* log illeggibile: vale l'altro */ }
      }
      // L'ora dal log vale solo se il job scrive a ogni giro: un log fermo oltre la tolleranza dei livelli (callsync,
      // jcode-auth-sync) non dice che il job è fermo, dice che sta zitto. Allora l'ora non si sa, resta l'exit di
      // launchctl, e il giro saltato lo dice il contatore di launchd (watchRuns). Stessa soglia dei livelli: niente
      // finestra in cui il log fermo accende «non gira» e poi lo spegne.
      let atUnknown = false;
      if (lastAt != null && everyMs && now - lastAt > everyMs + lateTolerance(everyMs, 'launchd')) { lastAt = null; atUnknown = true; }
      let outcome = null;
      if (entry) {
        if (entry.pid !== '-' && entry.pid !== '') outcome = 'running';
        else if (entry.status !== 0) outcome = rinviatoOInCorso(label, now) ? 'running' : 'error';
        // launchd non registra quando un job parte: senza log e senza errore è «mai girato», con un log muto è l'ultimo exit
        else outcome = lastAt != null || atUnknown ? 'ok' : null;
      }
      let expectedLast = null, next = null;
      if (cal.length) {
        const { prev, next: nx } = calNextPrev(cal, now);
        expectedLast = prev;
        next = nx;
      } else if (p.StartInterval) {
        next = lastAt != null ? lastAt + p.StartInterval * 1000 : null;
      }
      const runsToday = p.StartInterval ? Math.floor((now - midnightMs) / (p.StartInterval * 1000))
        : cal.length ? calTodayCount(cal, now) : 0;
      const stepped = p.StandardOutPath ? readStepRuns(path.join(path.dirname(p.StandardOutPath), 'runs.jsonl')) : null;
      if (stepped && outcome !== 'running') { lastAt = stepped.runs[0].at; outcome = stepped.runs[0].outcome; }
      const args = (p.ProgramArguments || (p.Program ? [p.Program] : [])).map(String);
      const sched = {};
      if (p.StartInterval != null) sched.StartInterval = p.StartInterval;
      if (p.StartCalendarInterval != null) sched.StartCalendarInterval = p.StartCalendarInterval;
      if (p.WatchPaths != null) sched.WatchPaths = p.WatchPaths;
      items.push({
        key: `launchd:${label}`,
        provider: 'launchd',
        name: label,
        enabled,
        everyMs,
        when,
        next,
        expectedLast,
        last: { at: lastAt, outcome, delivered: null, error: null, ...(atUnknown ? { atUnknown: true } : {}) },
        runs: stepped ? stepped.runs.slice(0, 10).map((r) => ({ at: r.at, outcome: r.outcome })) : lastAt != null ? [{ at: lastAt, outcome }] : [],
        ...(stepped ? { steps: stepped.steps } : {}),
        runsToday,
        who: whoOfArgs(args),
        reportsTo: 'nessun messaggio',
        tech: {
          exit: entry ? entry.status : null,
          command: args.join(' ').replace(new RegExp(os.homedir(), 'g'), '~'),
          label,
          schedule: JSON.stringify(sched),
        },
      });
    }
    return { ok: true, at: now, items, services };
  } catch (e) {
    return { ok: false, at: now, items: [], error: String(e?.message || e) };
  }
}

// Il contatore dei giri di launchd («runs» in launchctl print), osservato dall'hub a ogni lettura.
// Si muove: un giro c'è stato da allora (ora approssimata, se il log non la dice). Fermo: noRunSince = da quando
// lo vediamo fermo, e i livelli decidono se è un giro saltato. La memoria riparte con l'hub: si giudica solo
// dopo aver guardato abbastanza a lungo.
export function watchRuns(items, counts, now, memo) {
  for (const it of items) {
    const n = counts.get(it.name);
    if (n == null || it.enabled === false) continue;
    const seen = memo.get(it.name);
    if (!seen || seen.runs !== n) {
      memo.set(it.name, { runs: n, since: now });
      if (seen && it.last && it.last.at == null && it.last.outcome !== 'running') it.last = { ...it.last, at: now, atUnknown: false, atApprox: true };
      continue;
    }
    if (it.last && it.last.at != null && it.last.at > seen.since) continue; // il log dice un giro più recente
    it.noRunSince = seen.since;
  }
  return items;
}

// «runs = 968» da launchctl print; null se il job non c'è o la riga manca.
export function parseRuns(text) {
  const m = /^\s*runs = (\d+)/m.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}
