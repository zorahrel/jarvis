// Cache dello stato per l'hook di sessione: scritta da `hub check|refresh`, mai ricalcolata a ogni prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function cacheDir() {
  return process.env.USAGE_HUB_CACHE || path.join(os.homedir(), '.cache', 'claude-usage-hub');
}
export const statusFile = () => path.join(cacheDir(), 'status.json');

export function buildStatus(report, budgets) {
  const projects = {};
  for (const [name, b] of Object.entries(budgets)) {
    const p = report.projects.find((x) => x.name === name);
    const m = report.muse && report.muse.projects.find((x) => x.name === name);
    const weekPct = p ? p.weekPct : 0;
    projects[name] = {
      label: b.label || name, match: b.match || [], hint: b.hint || '',
      weekPct, budgetPct: b.budgetPct, over: weekPct > b.budgetPct,
      muse: m ? { requests: m.requests, tokens: m.tokens } : null,
    };
  }
  return { at: Date.now(), weekResetsAt: report.account.weekResetsAt, accountPct: report.account.weekPct, projects };
}

export function writeStatus(status, file = statusFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, file);
}

export function readStatus(file = statusFile()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function hookLine(p) {
  return `${p.label}: ${p.weekPct}% della settimana, budget ${p.budgetPct}%${p.hint ? `: ${p.hint}` : ''}`;
}
