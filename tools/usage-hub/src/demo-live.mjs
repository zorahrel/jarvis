// Dati finti per `serve --demo`: quote, Mac, agenti, contesto e servizi inventati, così la demo è tutta di prova
// (nessun account, progetto o percorso veri) e la fascia «ESEMPIO» dice il vero. Nessuna funzione legge disco o rete.

const H = 3600, D = 86400;

function quotaHist(nowS, startS, endPct) {
  const out = [];
  for (let t = startS, i = 0; t <= nowS; t += 2 * H, i++) out.push({ t, v: Math.round(endPct * (t - startS) / Math.max(1, nowS - startS)) });
  return out;
}

function account(id, label, code, active, weekPct, fivePct, nowS) {
  const weekReset = nowS + 3 * D, fiveReset = nowS + 2 * H;
  return { id, label, code, active, status: 'ok', quotas: [
    { key: '5h', usedPct: fivePct, resetsAt: fiveReset, resetText: '2h', status: 'ok', history: quotaHist(nowS, nowS - 3 * H, fivePct) },
    { key: '7d', usedPct: weekPct, resetsAt: weekReset, resetText: '3g', status: 'ok', history: quotaHist(nowS, nowS - 4 * D, weekPct) },
  ] };
}

export function demoOverview(now = Date.now()) {
  const s = Math.floor(now / 1000);
  return { ok: true, at: now, providers: [
    { id: 'claude', name: 'Claude', accounts: [account('anna@esempio.it', 'anna@esempio.it', 'ANN', true, 58, 40, s), account('team@esempio.it', 'team@esempio.it', 'TEA', false, 31, 0, s)] },
    { id: 'codex', name: 'Codex', accounts: [account('dev@esempio.it', 'dev@esempio.it', 'DEV', true, 44, 12, s)] },
    { id: 'muse', name: 'Muse', accounts: [account('muse@esempio.it', 'muse@esempio.it', 'MUS', true, 23, 5, s)] },
  ] };
}

export function demoMac(now = Date.now()) {
  const s = Math.floor(now / 1000), hist = (base) => Array.from({ length: 24 }, (_, i) => ({ t: s - (23 - i) * 600, v: Math.max(0, Math.min(100, base + Math.round(Math.sin(i / 3) * 12))) }));
  return { at: now, cores: 8, load1: 3.2, loadPerCore: 0.4, maxLoadPerCore: 1.5, swapUsedGB: 1, swapTotalGB: 2, swapSustained: false, strained: false, reason: '',
    hogs: [{ pid: 1, name: 'editor di esempio', kind: 'app', memMB: 1800, n: 1 }],
    effort: { level: 0, label: 'tranquillo', driver: 'cpu', why: '', score: 30, parts: [
      { key: 'cpu', name: 'CPU', pct: 35, level: 0, load: 0 }, { key: 'mem', name: 'memoria', pct: 62, level: 0 },
      { key: 'gpu', name: 'GPU', pct: 8, level: 0 }, { key: 'disk', name: 'disco', pct: 48, level: 0 }] },
    history: { cpu: hist(35), mem: hist(62), gpu: hist(8), disk: hist(48) },
    mem: { totalGB: 16, usedGB: 9.9, appGB: 5.2, wiredGB: 2.1, compressedGB: 1.4, cachedGB: 1.2, freeGB: 3.1 },
    disk: { freeGB: 260, totalGB: 500 }, trees: [], paused: [], note: 'demo' };
}

// Agenti vivi per progetto finto (stessa forma di scanAgents): uno per i due progetti più attivi della demo.
export function demoAgents(now = Date.now()) {
  const a = (project, provider, model, title, minsAgo) => ({ project, provider, model, title, cliId: 'demo-' + project, depth: 0, cwd: '/work/' + project, startedAt: now - minsAgo * 60000, lastActivity: now - 60000 });
  // la prima ha il link «apri» come le sessioni vere aperte in un tab (serve alla barra: link nel testo, contrasto)
  // una cartella scratch-…: il nome grezzo non va in pagina, si legge il titolo («Prova del 22/10»)
  return [{ ...a('billing-api', 'claude', 'Sonnet', 'Sistemare il calcolo delle fatture', 42), open: { url: '#projects', via: 'tab Topics' } }, a('scratch-2026-10-22-a1b2c3', 'claude', 'Haiku', 'Prova veloce di un comando', 7), a('mobile-app', 'codex', 'gpt-5', 'Test della schermata di accesso', 15)];
}

export function demoContext(now = Date.now()) {
  const f = (id, label, path, group, tokens) => ({ id, label, path, group, loaders: ['Claude Code'], bytes: tokens * 4, chars: tokens * 4, tokens, mtime: now - 86400000, note: '', includedBy: null, generatedFrom: null });
  const files = [f('global', 'Istruzioni globali', '~/esempio/CLAUDE.md', 'Claude Code', 2100), f('tools', 'Strumenti', '~/esempio/TOOLS.md', 'Claude Code', 1400), f('mem', 'Indice della memoria', '~/esempio/memory/MEMORY.md', 'Memoria', 900)];
  return { at: now, files, skills: { count: 3, tokens: 150, loaders: ['Claude Code'], items: [{ name: 'scrivi-commit', chars: 180, tokens: 45, path: '~/esempio/skills/scrivi-commit/SKILL.md' }, { name: 'rivedi-pr', chars: 200, tokens: 50, path: '~/esempio/skills/rivedi-pr/SKILL.md' }, { name: 'prepara-rilascio', chars: 220, tokens: 55, path: '~/esempio/skills/prepara-rilascio/SKILL.md' }] }, duplicates: [], oldRules: [], doctor: { ok: true, checks: [{ ok: true, text: 'nessun link rotto (esempio)' }], error: null },
    totals: { byLoader: { 'Claude Code': files.reduce((s, x) => s + x.tokens, 0) + 150 } } };
}

export function demoServices(now = Date.now()) {
  const sv = (name, what, state, mb, group, app = false) => ({ name, what, state, mb, group, app, port: null, label: '', problem: '' });
  return { at: now, services: [sv('Hub di esempio', 'questa pagina', 'vivo', 120, 'App', true), sv('Coda di esempio', 'lancia gli agenti', 'in attesa', null, 'Agenti')] };
}
