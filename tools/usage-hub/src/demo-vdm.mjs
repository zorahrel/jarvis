// Il proxy VDM finto della demo: account, impostazioni, sessioni, consumi e attività inventati, con dentro i testi
// sporchi che il proxy vero manda davvero (messaggi di servizio di OpenClaw, orari fra parentesi, nomi mcp__,
// percorsi assoluti, cartelle con un uuid). Così la barra disegna Sessioni e Consumi con dati e vede se qualcosa
// di interno arriva in pagina. Nessun dato vero: niente numeri, nessun account reale.
const H = 3600000, D = 24 * H;

export function demoVdm(url, now = Date.now()) {
  const u = new URL(url, 'http://demo');
  const p = u.pathname.replace(/^\/vdm/, '');
  if (p === '/api/settings') return { proxyEnabled: true, autoSwitch: true, notifications: true, usageCap5h: 90, usageCap7d: null, usageCapHoldMin: 10, usdEur: 0.92, rotationStrategy: 'reset-first', sessionMonitor: true };
  if (p === '/api/profiles') return profiles(now);
  if (p === '/api/sessions') return sessions(now);
  if (p === '/api/activity') return { log: [
    { type: 'auto-switch', ts: now - 40 * 60000, from: 'principale', to: 'riserva' },
    { type: 'rate-limited', ts: now - 2 * H, account: 'principale', retryAfter: 1800 },
    { type: 'manual-switch', ts: now - 26 * H, to: 'principale' },
  ] };
  if (p === '/api/token-usage') return tokenUsage(now, Number(u.searchParams.get('days')) || 7);
  return null;
}

function profiles(now) {
  const rl = (a, b) => ({ fiveH: { utilization: a, reset: Math.floor((now + 2 * H) / 1000) }, sevenD: { utilization: b, reset: Math.floor((now + 3 * D) / 1000) } });
  return {
    rotationStrategy: 'reset-first',
    profiles: [
      { name: 'principale', label: 'Principale', subscriptionType: 'max', rateLimitTier: 'max_20x', isActive: true, priority: 2, rateLimits: rl(0.42, 0.61), minutesToLimit: 380 },
      { name: 'riserva', label: 'Riserva', subscriptionType: 'max', rateLimitTier: 'max_5x', priority: 1, rateLimits: rl(0.08, 0.93), limited: true, blockKind: 'quota-7d', retryAfter: now + 3 * D },
    ],
  };
}

function sessions(now) {
  const tl = [
    { type: 'input', text: '[Sat 2026-10-24 02:56 GMT+2] controlla la quota di Codex e dimmi se reggiamo fino a lunedì' },
    { type: 'tool', text: 'mcp__openclaw__exec: date; ls /Users/esempio/.assistente/workspace/memory' },
    { type: 'tool', text: 'mcp__openclaw__process' },
    { type: 'output', text: 'I acknowledge this is an inter-session message routed from Discord.' },
    { type: 'output', text: 'This message appears to be inter-session routing data, not a request from the user.' },
  ];
  return {
    enabled: true,
    active: [
      { account: 'principale', cwd: '/Users/esempio/Projects/fatture-web', repo: 'fatture-web', branch: 'main', startedAt: now - 50 * 60000, lastActiveAt: now - 30000, model: 'claude-opus-5', requestCount: 41, totalInputTokens: 880000, totalOutputTokens: 52000, currentActivity: 'Editing /Users/esempio/Projects/fatture-web/src/components/InvoiceTable.tsx', timeline: tl },
      { account: 'riserva', cwd: '/Users/esempio/Library/Application Support/Claude/local_5d58bb9d-5000-4466-ac64-6a505dba24a6', startedAt: now - 3 * H, lastActiveAt: now - 9 * 60000, model: 'claude-sonnet-5', requestCount: 12, totalInputTokens: 210000, totalOutputTokens: 9000, currentActivity: 'Reading /Users/esempio/.note/diario/2026-10-24.jsonl', timeline: tl.slice(0, 2) },
    ],
    recent: [
      { account: 'principale', cwd: '/Users/esempio/.assistente/_sys_226619bc', model: 'claude-sonnet-5', startedAt: now - 6 * H, completedAt: now - 5 * H, duration: H, totalInputTokens: 420000, totalOutputTokens: 31000, timeline: tl.slice(3) },
    ],
    conflicts: [],
  };
}

function tokenUsage(now, days) {
  const out = [], models = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], accts = ['principale', 'riserva'], repos = ['/Users/esempio/Projects/fatture-web', '/Users/esempio/Projects/agenda-studio', '/Users/esempio/.assistente/workspace'];
  for (let i = 0; i < days * 12; i++) {
    out.push({ ts: now - (i / 12) * D, repo: repos[i % 3], branch: i % 4 ? 'main' : 'nuova-fattura', model: models[i % 3], account: accts[i % 2], inputTokens: 20000 + (i * 7919) % 90000, outputTokens: 2000 + (i * 104729) % 9000, cacheReadTokens: 150000 });
  }
  return out;
}
