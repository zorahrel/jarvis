// Combina scansione e quota: quota del progetto = sua parte di token × % settimanale dell'account.
import { scanProjects } from './usage.mjs';
import { getQuota, getMuseQuota, getCodexQuota } from './quota.mjs';
import path from 'node:path';
import os from 'node:os';
import { spendSummary } from '../modules/vdm/api-spend.mjs';
import { scanFree } from './free.mjs';
import { scanCodex, splitCodex } from './codex.mjs';
import { scanMuse } from './muse.mjs';
import { makeResolver } from './openclaw.mjs';
import { fetchProxy } from './vdm.mjs';

// `trackers` ({ claude, codex, muse, proxy }): nel hub restano vivi tra un giro e l'altro e leggono solo i byte nuovi;
// senza, ogni chiamata rilegge tutto (CLI, test).
export async function buildReport(config, { fetchImpl, root, museRoot, codexRoot, openclaw, trackers } = {}) {
  const quota = await getQuota(config.quotaSource, fetchImpl);
  // L'etichetta dell'account è di solito una email: si maschera salvo richiesta esplicita.
  if (!config.showAccount) quota.label = quota.label.slice(0, 2) + '…';
  const sinceMs = quota.weekResetsAt - 7 * 86400000;
  // Il risolutore OpenClaw si attiva con config.openclaw (o iniettato nei test); senza, resta tutto come prima.
  const oc = openclaw || (config.openclaw ? await makeResolver(config.openclaw) : undefined);
  let raw;
  if (trackers?.claude) {
    await trackers.claude.updateAsync({ root, sinceMs });
    raw = trackers.claude.aggregate({ sinceMs, weights: config.weights, groups: config.groups, openclaw: oc });
  } else raw = scanProjects({ root, sinceMs, weights: config.weights, groups: config.groups, openclaw: oc });
  const total = Object.values(raw).reduce((s, p) => s + p.tokens, 0) || 1;
  const projects = Object.entries(raw)
    .map(([name, p]) => ({
      name,
      tokens: Math.round(p.tokens),
      share: p.tokens / total,
      weekPct: Math.round((p.tokens / total) * quota.weekPct * 10) / 10,
      requests: p.requests,
      subRequests: p.subRequests || 0,
      subWeekPct: Math.round(((p.subTokens || 0) / total) * quota.weekPct * 10) / 10,
      lastAt: p.lastAt,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  // Il proxy VDM si interroga solo se configurato (config.vdm: true o { url }); fuori servizio non rompe il report.
  const proxy = config.vdm ? await fetchProxy(config.vdm.url, fetchImpl || fetch, { sinceMs, weights: config.weights, groups: config.groups, openclawRoot: oc && oc.root, feed: trackers?.proxy }) : null;
  // Quota Muse dalla tray: seconda lettura best effort, mai un errore.
  let museQuota = null;
  try { museQuota = await getMuseQuota(config.quotaSource, fetchImpl || fetch); } catch { /* tray giù: quota assente */ }
  const museSinceMs = museQuota?.weekResetsAt ? museQuota.weekResetsAt - 7 * 86400000 : sinceMs;
  const codex = await buildCodex(config, codexRoot, oc, fetchImpl || fetch, sinceMs, trackers?.codex);
  return { at: Date.now(), account: quota, sinceMs, projects, muse: await buildMuse(config, museSinceMs, museRoot, oc, museQuota, trackers?.muse), codex, apiSpend: buildApiSpend(config), free: config.free === false ? null : scanFree({ file: config.freeLog, sinceMs }), proxy };
}

// Muse non pubblica un limite leggibile: si contano richieste e token nella stessa finestra settimanale.
// La % di quota vera arriva dalla tray (stessa overview di Claude): quota null se non leggibile.
async function buildMuse(config, sinceMs, museRoot, oc, museQuota = null, tracker) {
  if (!config.muse && !museRoot && !museQuota) return null;
  let raw = {};
  const groups = [...(config.groups || [])];
  for (const [name, budget] of Object.entries(config.budgets || {})) {
    const existing = groups.findIndex((group) => group.name === name);
    if (existing >= 0) groups.splice(existing, 1);
    groups.push({ name, match: budget.match || [] });
  }
  try {
    if (tracker) { await tracker.updateAsync({ root: museRoot, sinceMs }); raw = tracker.aggregate({ sinceMs, groups, openclaw: oc }); }
    else raw = scanMuse({ root: museRoot, sinceMs, groups, openclaw: oc });
  } catch { /* sessioni illeggibili: sezione vuota */ }
  const reportedTokens = Object.values(raw).reduce((sum, p) => sum + (p.reportedTokens || 0), 0);
  const hasTokenCounts = Object.values(raw).some((p) => p.tokenCountEvents > 0);
  const unit = hasTokenCounts ? 'tokens' : 'turns';
  const total = unit === 'tokens'
    ? reportedTokens
    : Object.values(raw).reduce((sum, p) => sum + p.requests, 0);
  const projects = Object.entries(raw)
    .map(([name, p]) => {
      const weight = unit === 'tokens' ? p.reportedTokens : p.requests;
      const share = total ? weight / total : 0;
      return {
        name,
        requests: p.requests,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        reasoningTokens: p.reasoningTokens,
        wonderRequests: p.wonderRequests,
        lastAt: p.lastAt,
        tokens: p.reportedTokens,
        weight,
        unit,
        share,
        weekPct: museQuota?.weekPct == null ? null : Math.round(share * museQuota.weekPct * 10) / 10,
      };
    })
    .sort((a, b) => b.weight - a.weight);
  return {
    limit: null,
    note: 'Muse does not expose its limit: projects are allocated by tokens, or by model turns when token counts are absent',
    quota: museQuota,
    sinceMs,
    unit,
    projects,
  };
}

// Codex: % settimanale globale dalla tray, divisa per progetto dai log delle sessioni (cwd).
// Senza log né quota la sezione manca, mai un errore.
async function buildCodex(config, codexRoot, oc, fetchImpl, fallbackSince, tracker) {
  if (config.codex === false) return null;
  const quota = await getCodexQuota(config.quotaSource, fetchImpl);
  const sinceMs = quota?.weekResetsAt ? quota.weekResetsAt - 7 * 86400000 : fallbackSince;
  let raw = {};
  try {
    if (tracker) { await tracker.updateAsync({ root: codexRoot, sinceMs }); raw = tracker.aggregate({ sinceMs, groups: config.groups, openclaw: oc }); }
    else raw = scanCodex({ root: codexRoot, sinceMs, groups: config.groups, openclaw: oc });
  } catch { /* log illeggibili */ }
  if (!quota && !Object.keys(raw).length) return null;
  return { quota, sinceMs, projects: splitCodex(raw, quota ? quota.weekPct : null) };
}

// Spesa API Anthropic per chiave e per modello, dallo stesso file che scrive VDM.
// Il file sta nella cartella di stato di VDM; senza dati la sezione è null.
export function buildApiSpend(config, now = Date.now()) {
  const dir = process.env.VDM_STATE_DIR || path.join(os.homedir(), '.claude', 'account-switcher');
  const file = config.apiSpendFile || process.env.VDM_API_SPEND_FILE || path.join(dir, 'api-spend.json');
  try {
    const s = spendSummary({ now, file });
    return s.perKeyModel.length || s.today || s.last7d ? s : null;
  } catch { return null; }
}
