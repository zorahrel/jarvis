// Ultimi giri dei workflow Claude Code + stato vivo di Lobster: solo file locali, sincrono.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const wfStatus = (s) => (s === 'failed' ? 'error' : s === 'running' ? 'running' : 'ok');
const lobStatus = (s) => (s === 'failed' || s === 'error' ? 'error' : (s === 'running' || s === 'waiting-approval' ? 'running' : 'ok'));

const sameDay = (at, now) => at != null && new Date(at).toDateString() === new Date(now).toDateString();
const leadingErrors = (rs) => { let n = 0; for (const r of rs) { if (r.outcome === 'error' || r.status === 'error') n++; else break; } return n; };

function toRun(j, file) {
  const at = j.startTime || (j.timestamp ? Date.parse(j.timestamp) : null) || null;
  const agents = Array.isArray(j.workflowProgress)
    ? j.workflowProgress.filter((e) => e && e.type === 'workflow_agent')
    : [];
  const phases = Array.isArray(j.phases) ? j.phases.map((p, i) => {
    const mine = agents.filter((e) => e.phaseIndex === i + 1);
    return {
      title: p.title,
      total: mine.length,
      done: mine.filter((e) => e.state === 'done').length,
      failed: mine.filter((e) => e.state === 'failed').length,
    };
  }) : [];
  return {
    runId: j.runId,
    name: j.workflowName,
    summary: j.summary || null,
    status: wfStatus(j.status),
    at: Number.isFinite(at) ? at : null,
    durationMs: j.durationMs ?? null,
    agents: j.agentCount ?? null,
    tokens: j.totalTokens ?? null,
    model: j.defaultModel || null,
    file,
    phases,
  };
}

function wfItem(name, rs, now) {
  const [latest] = rs;
  return {
    key: 'workflow:' + name,
    provider: 'workflow',
    name,
    enabled: true,
    everyMs: null,
    when: 'quando lo lanci',
    next: null,
    nextApprox: false,
    expectedLast: null,
    last: { at: latest.at, outcome: latest.status, delivered: null, error: null },
    runs: rs.slice(0, 10).map((r) => ({ at: r.at, outcome: r.status, runId: r.runId })),
    consecutiveErrors: leadingErrors(rs),
    runsToday: rs.filter((r) => sameDay(r.at, now)).length,
    who: 'Claude Code (workflow)',
    reportsTo: 'la sessione che lo lancia',
    summary: latest.summary,
    tech: { schedule: null, exit: null, command: latest.file, prompt: null, label: name, url: null },
  };
}

function readLobsterRuns(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); } // assente: zero lobster
  const by = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // riga sporca: si salta
    if (!e.workflow) continue;
    if (!by.has(e.workflow)) by.set(e.workflow, []);
    by.get(e.workflow).push({
      at: e.ts ? Date.parse(e.ts) || null : null,
      outcome: lobStatus(e.status),
    });
  }
  return by;
}

function lobItem(name, rows, now) {
  const ordered = [...rows].sort((a, b) => (b.at || 0) - (a.at || 0));
  const [latest] = ordered;
  return {
    key: 'lobster:' + name,
    provider: 'lobster',
    name,
    enabled: true,
    everyMs: null,
    when: 'quando lo lancia Lobster',
    next: null,
    nextApprox: false,
    expectedLast: null,
    last: { at: latest.at, outcome: latest.outcome, delivered: null, error: null },
    runs: ordered.slice(0, 10).map((r) => ({ at: r.at, outcome: r.outcome })),
    consecutiveErrors: leadingErrors(ordered),
    runsToday: ordered.filter((r) => sameDay(r.at, now)).length,
    who: 'Lobster',
    reportsTo: 'nessun messaggio',
    tech: { schedule: null, exit: null, command: null, prompt: null, label: name, url: null },
  };
}

function blankLobster(name) {
  return {
    key: 'lobster:' + name,
    provider: 'lobster',
    name,
    enabled: true,
    everyMs: null,
    when: 'quando lo lancia Lobster',
    next: null,
    nextApprox: false,
    expectedLast: null,
    last: { at: null, outcome: 'running', delivered: null, error: null },
    runs: [],
    consecutiveErrors: 0,
    runsToday: 0,
    who: 'Lobster',
    reportsTo: 'nessun messaggio',
    tech: { schedule: null, exit: null, command: null, prompt: null, label: name, url: null },
  };
}

// Ogni workflow_resume_*.json con approvalStepId è un workflow fermo al cancello di approvazione.
function applyResumeState(dir, items) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return; } // stato assente: niente fermi
  for (const f of files) {
    if (!f.startsWith('workflow_resume_') || !f.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!j.approvalStepId) continue;
    const name = path.basename(String(j.filePath || ''), '.lobster') || f;
    let item = items.find((i) => i.key === 'lobster:' + name);
    if (!item) { item = blankLobster(name); items.push(item); }
    item.waitingApproval = {
      step: j.approvalStepId,
      since: j.createdAt ? Date.parse(j.createdAt) || null : null,
      token: f.replace(/\.json$/, ''),
      file: j.filePath || null,
    };
  }
}

export function readWorkflows({ projectsDir, lobsterRuns, lobsterState, now = Date.now(), days = 7 } = {}) {
  const home = os.homedir();
  projectsDir ??= path.join(home, '.claude/projects');
  lobsterRuns ??= path.join(home, '.openclaw/workflows/runs.jsonl');
  lobsterState ??= path.join(home, '.lobster/state');
  const cutoff = now - days * 86400000;
  const runs = [];
  let skipped = 0;
  let l1 = [];
  try { l1 = fs.readdirSync(projectsDir); } catch { l1 = []; }
  for (const a of l1) {
    let l2 = [];
    try { l2 = fs.readdirSync(path.join(projectsDir, a)); } catch { continue; }
    for (const b of l2) {
      for (const sub of ['workflows', path.join('subagents', 'workflows')]) {
        let files = [];
        try { files = fs.readdirSync(path.join(projectsDir, a, b, sub)); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('wf_') || !f.endsWith('.json')) continue;
          const file = path.join(projectsDir, a, b, sub, f);
          let st;
          try { st = fs.statSync(file); } catch { continue; }
          if (st.mtimeMs < cutoff) continue; // fuori finestra: non è attività recente
          try { runs.push(toRun(JSON.parse(fs.readFileSync(file, 'utf8')), file)); }
          catch { skipped++; } // illeggibile: si salta e si conta
        }
      }
    }
  }
  runs.sort((a, b) => (b.at || 0) - (a.at || 0));
  const byName = new Map();
  for (const r of runs) {
    if (!r.name) continue;
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  const items = [...byName.entries()].map(([name, rs]) => wfItem(name, rs, now));
  for (const [name, rows] of readLobsterRuns(lobsterRuns)) items.push(lobItem(name, rows, now));
  applyResumeState(lobsterState, items);
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, at: now, items, runs, skipped };
}
