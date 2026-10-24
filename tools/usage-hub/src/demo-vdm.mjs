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
    { type: 'auto-switch', ts: now - 40 * 60000, from: 'anna@esempio.it', to: 'team@esempio.it' },
    { type: 'rate-limited', ts: now - 2 * H, account: 'anna@esempio.it', retryAfter: 1800 },
    { type: 'manual-switch', ts: now - 26 * H, to: 'anna@esempio.it' },
    // eventi che la pagina mostrava come chiavi grezze inglesi (giro 8)
    { type: 'priority-set', ts: now - 27 * H, name: 'team@esempio.it', priority: 1 },
    { type: 'account-cap', ts: now - 28 * H, name: 'team@esempio.it', fiveH: 63, sevenD: 64 },
    { type: 'upstream-retry', ts: now - 29 * H, account: 'anna@esempio.it', status: 529, attempt: 1 },
  ] };
  if (p === '/api/token-usage') return tokenUsage(now, Number(u.searchParams.get('days')) || 7);
  return null;
}

function profiles(now) {
  const rl = (a, b) => ({ fiveH: { utilization: a, reset: Math.floor((now + 2 * H) / 1000) }, sevenD: { utilization: b, reset: Math.floor((now + 3 * D) / 1000) } });
  return {
    rotationStrategy: 'reset-first',
    profiles: [
      { name: 'anna@esempio.it', label: 'anna@esempio.it', subscriptionType: 'max', rateLimitTier: 'max_20x', isActive: true, priority: 2, rateLimits: rl(0.42, 0.61), minutesToLimit: 380 },
      { name: 'team@esempio.it', label: 'team@esempio.it', subscriptionType: 'max', rateLimitTier: 'max_5x', priority: 1, rateLimits: rl(0.08, 0.93), limited: true, blockKind: 'quota-7d', retryAfter: now + 3 * D },
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
    // varianti viste sul vivo il 24/10: risposte del riassuntore su se stesso, ripresa di sessione, esito grezzo
    { type: 'output', text: "I'm Claude, an AI assistant made by Anthropic." },
    { type: 'output', text: 'I appreciate you sharing this routing information, but I should clarify my role.' },
    { type: 'output', text: 'OpenClaw resumed this CLI session after prompt content changed.' },
    { type: 'output', text: 'Strumento di openclaw: exec: cd /Users/esempio/.assistente/workspace/pop-demo && python3 prova.py' },
    { type: 'output', text: 'ESITO: fatto\nPROVA: wc -l agenti/STRUMENTI.md\nCOMMIT: nessuno' },
    { type: 'output', text: 'Il calcolo delle fatture ora arrotonda al centesimo.' },
  ];
  return {
    enabled: true,
    active: [
      { account: 'anna@esempio.it', cwd: '/Users/esempio/Projects/fatture-web', repo: 'fatture-web', branch: 'main', startedAt: now - 50 * 60000, lastActiveAt: now - 30000, model: 'claude-opus-5', requestCount: 41, totalInputTokens: 880000, totalOutputTokens: 52000, currentActivity: 'Editing /Users/esempio/Projects/fatture-web/src/components/InvoiceTable.tsx', timeline: tl },
      { account: 'team@esempio.it', cwd: '/Users/esempio/Library/Application Support/Claude/local_0e5a1d2c-1111-4222-8333-944455556666', startedAt: now - 3 * H, lastActiveAt: now - 9 * 60000, model: 'claude-sonnet-5', requestCount: 12, totalInputTokens: 210000, totalOutputTokens: 9000, currentActivity: 'Write /private/tmp/claude-501/-Users-esempio-Projects-fatture/scratchpad/prova.md', timeline: tl.slice(0, 2) },
    ],
    recent: [
      { account: 'anna@esempio.it', cwd: '/Users/esempio/.assistente/_sys_a1b2c3d4', model: 'claude-sonnet-5', startedAt: now - 6 * H, completedAt: now - 5 * H, duration: H, totalInputTokens: 420000, totalOutputTokens: 31000, timeline: tl.slice(3) },
    ],
    conflicts: [],
  };
}

function tokenUsage(now, days) {
  const out = [], models = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], accts = ['anna@esempio.it', 'team@esempio.it'], repos = ['/Users/esempio/Projects/fatture-web', '/Users/esempio/Projects/agenda-studio', '/Users/esempio/.assistente/workspace'];
  for (let i = 0; i < days * 12; i++) {
    out.push({ ts: now - (i / 12) * D, repo: repos[i % 3], branch: i % 4 ? 'main' : 'nuova-fattura', model: models[i % 3], account: accts[i % 2], inputTokens: 20000 + (i * 7919) % 90000, outputTokens: 2000 + (i * 104729) % 9000, cacheReadTokens: 150000 });
  }
  return out;
}
