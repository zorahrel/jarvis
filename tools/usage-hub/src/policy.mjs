// Motore di policy multibudget: ogni policy guarda una misura del report e decide warn o block.
// Il blocco vale solo se la policy lo chiede (enforce) E scatta su un progetto: tutto il resto avvisa.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './status.mjs';

export const blocksFile = () => path.join(cacheDir(), 'blocks.json');

// Misura di una policy: {value, unit} oppure null se il dato manca (la policy tace).
export function measure(report, p) {
  const find = (list, name) => (list || []).find((x) => x.name === name);
  switch (p.scope) {
    case 'project': return { value: find(report.projects, p.project)?.weekPct ?? 0, unit: '%' };
    case 'codex-project': return report.codex ? { value: find(report.codex.projects, p.project)?.weekPct ?? 0, unit: '%' } : null;
    case 'muse-project': return report.muse ? { value: (find(report.muse.projects, p.project)?.weekPct) ?? 0, unit: '%' } : null;
    case 'account': return report.account ? { value: report.account.weekPct, unit: '%' } : null;
    case 'codex': return report.codex?.quota ? { value: report.codex.quota.weekPct, unit: '%' } : null;
    case 'muse': return report.muse?.quota ? { value: report.muse.quota.weekPct, unit: '%' } : null;
    case 'api-spend': {
      const s = report.apiSpend;
      if (!s) return null;
      return { value: p.key ? (s.perKey[p.key]?.last7d ?? 0) : s.last7d, unit: 'USD' };
    }
    default: return null;
  }
}

// Policy di base dai budget per progetto, più i tetti di account, Codex, Muse e spesa API.
export function defaultPolicies(budgets = {}, museBudget = null) {
  const out = [];
  for (const [name, b] of Object.entries(budgets)) {
    const enforce = b.enforce === true;
    out.push({ id: `project:${name}`, scope: 'project', project: name, threshold: b.budgetPct, action: enforce ? 'block' : 'warn', enforce, label: b.label || name });
    out.push({ id: `codex-project:${name}`, scope: 'codex-project', project: name, threshold: b.budgetPct, action: 'warn', label: b.label || name });
  }
  if (museBudget) out.push({ id: 'muse', scope: 'muse', threshold: museBudget.budgetPct, action: 'warn', label: museBudget.label });
  out.push({ id: 'account', scope: 'account', threshold: 90, action: 'warn', label: 'Claude 7d' });
  out.push({ id: 'codex', scope: 'codex', threshold: 90, action: 'warn', label: 'Codex 7d' });
  out.push({ id: 'api-spend', scope: 'api-spend', threshold: 20, action: 'warn', label: 'Spesa API 7g' });
  return out;
}

// fake: { policyId: valore } sostituisce la misura, per provare una policy senza aspettare il consumo vero.
export function evaluatePolicies(report, policies, { fake = {} } = {}) {
  const results = [];
  for (const p of policies) {
    const m = p.id in fake ? { value: Number(fake[p.id]), unit: p.scope === 'api-spend' ? 'USD' : '%' } : measure(report, p);
    if (!m || !Number.isFinite(m.value) || m.value <= p.threshold) continue;
    // Il blocco è concesso solo ai progetti con enforce: una policy "block" altrove degrada ad avviso.
    const blocks = p.action === 'block' && p.enforce === true && p.scope === 'project';
    results.push({
      id: p.id, scope: p.scope, subject: p.label || p.id, value: m.value, threshold: p.threshold, unit: m.unit,
      action: blocks ? 'block' : 'warn', project: p.project,
      message: `${p.label || p.id}: ${m.value}${m.unit === 'USD' ? ' USD' : '%'} sopra ${p.threshold}${m.unit === 'USD' ? ' USD' : '%'} → ${blocks ? 'BLOCCO' : 'avviso'}`,
    });
  }
  return results;
}

// Applica i blocchi scrivendo il file letto da quota-guard e VDM; in dry-run non scrive niente.
export function applyBlocks(results, { dryRun = false, file = blocksFile(), now = Date.now() } = {}) {
  const blocked = results.filter((r) => r.action === 'block').map((r) => r.project);
  if (dryRun) return { blocked, written: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: now, blocked }));
  return { blocked, written: true };
}
