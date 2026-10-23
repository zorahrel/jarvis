import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBudgets, loadMuseBudget, budgetMessage } from './budgets.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(file) {
  const candidates = [file, process.env.USAGE_HUB_CONFIG, path.join(ROOT, 'config.json'),
    path.join(os.homedir(), '.config', 'claude-usage-hub', 'config.json')].filter(Boolean);
  const found = candidates.find((f) => fs.existsSync(f));
  const cfg = found ? JSON.parse(fs.readFileSync(found, 'utf8')) : {};
  cfg.port ||= 3350;
  cfg.stateFile ||= path.join(ROOT, 'state.json');
  cfg.alerts ||= { rules: [], notify: { command: `node ${JSON.stringify(path.join(ROOT, 'scripts', 'notify-stdout.mjs'))}` } };
  // I budget condivisi (file unico) aggiungono gruppi e regole; vincono sulle regole omonime del config.
  cfg.budgets = loadBudgets();
  cfg.muse ??= true;
  cfg.groups ||= [];
  cfg.alerts.rules ||= [];
  for (const [name, b] of Object.entries(cfg.budgets)) {
    cfg.groups = cfg.groups.filter((g) => g.name !== name).concat({ name, match: b.match || [] });
    cfg.alerts.rules = cfg.alerts.rules.filter((r) => !(r.scope === 'project' && r.project === name))
      .concat({ scope: 'project', project: name, threshold: b.budgetPct, message: budgetMessage(b).replace('{subject}', name) });
  }
  // Soglia Muse 7d da budgets.json (chiave "muse"): vince sulla regola omonima del config.
  const museBudget = loadMuseBudget();
  if (museBudget) {
    cfg.alerts.rules = cfg.alerts.rules.filter((r) => r.scope !== 'muse')
      .concat({ scope: 'muse', threshold: museBudget.budgetPct, message: `${museBudget.label}: {value}% della settimana, budget {threshold}%` });
  }
  return cfg;
}
