// Budget per progetto: un file unico, letto da hub, hook di sessione e quota-guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function budgetsFile() {
  return process.env.USAGE_HUB_BUDGETS || path.join(os.homedir(), '.config', 'claude-usage-hub', 'budgets.json');
}

export function loadBudgets(file = budgetsFile()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).projects || {}; } catch { return {}; }
}

// Soglia Muse 7d dallo stesso file (chiave top-level "muse"): assente = nessun avviso.
export function loadMuseBudget(file = budgetsFile()) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')).muse;
    return m && Number.isFinite(Number(m.budgetPct)) ? { label: m.label || 'Muse', budgetPct: Number(m.budgetPct) } : null;
  } catch {
    return null;
  }
}

// Claude Code nomina le cartelle di progetto come il cwd con / e . sostituiti da '-'.
export function sanitizeCwd(cwd) {
  return String(cwd || '').replace(/[\\/.]/g, '-');
}

export function matchBudget(cwd, projects) {
  const dir = sanitizeCwd(cwd);
  for (const [name, b] of Object.entries(projects || {})) {
    if ((b.match || []).some((m) => dir.includes(m))) return name;
  }
  return null;
}

export function budgetMessage(b) {
  return `${b.label || '{subject}'}: {value}% della settimana, budget {threshold}%${b.hint ? `: ${b.hint}` : ''}`;
}
