#!/usr/bin/env node
import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { buildReport } from '../src/projects.mjs';
import { runAlerts } from '../src/alerts.mjs';
import { createServer } from '../src/server.mjs';
import { makeDemoRoot, removeOnExit, seedDemoAttesa, seedDemoDiary } from '../src/demo.mjs';
import { defaultPolicies, evaluatePolicies, applyBlocks } from '../src/policy.mjs';
import { loadBudgets, loadMuseBudget } from '../src/budgets.mjs';
import { buildStatus, writeStatus } from '../src/status.mjs';
import { buildPace, gate } from '../src/pacing.mjs';
import { modelFor } from '../src/route.mjs';
import { loadOverrides, activeOverrides, addOverride, revokeOverride } from '../src/overrides.mjs';
import { readAll, buildState, openItems } from '../src/automations/feedback.mjs';
import { createDemoAutomations } from '../src/automations/demo.mjs';
import { demoOverview, demoMac, demoAgents, demoContext, demoServices } from '../src/demo-live.mjs';

const trayOverview = async () => (await fetch(`${(config.tray && config.tray.url) || 'http://127.0.0.1:3360'}/api/overview`, { signal: AbortSignal.timeout(20000) })).json();
const hhmm = (ms) => new Date(ms).toLocaleString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const [cmd = 'serve', ...rest] = process.argv.slice(2);
const config = loadConfig();
if (rest.includes('--demo')) {
  // Dati finti per screenshot e prove: nessun log letto, nessuna tray necessaria.
  const now = Date.now();
  config.quotaSource = { type: 'manual', label: 'demo', weekPct: 62, weekResetsAt: now + 3 * 86400000, fiveHourPct: 35 };
  config.root = removeOnExit(makeDemoRoot());
  config.port = 3351;
  // «Da cambiare» in demo mette in coda un agente: la coda di prova sta accanto ai log finti, mai in quella vera dell'hub
  // e non parte da sola (noQueue nel server): resta lì per essere letta dalla prova.
  process.env.USAGE_HUB_QUEUE ||= `${config.root}/queue.json`;
  process.env.USAGE_HUB_QUEUE_LOG ||= `${config.root}/queue.log`;
  config.alerts = { rules: [{ scope: 'project', project: 'billing-api', threshold: 15 }, { scope: 'account', metric: '7d', threshold: 80 }] };
  // Niente fonti vere nei consumi: proxy VDM, canali gratis, OpenClaw e gruppi di progetti sono di questo Mac
  Object.assign(config, { vdm: false, free: false, openclaw: null, groups: [], pcName: 'PC di esempio' });
  // «Ti aspetta», feedback e override veri non si leggono né si scrivono dalla demo
  process.env.USAGE_HUB_ATTESA ||= seedDemoAttesa(config.root);
  process.env.USAGE_HUB_FEEDBACK_DIR ||= `${config.root}/feedback`;
  process.env.USAGE_HUB_OVERRIDES ||= `${config.root}/overrides.json`;
  process.env.USAGE_HUB_BUDGETS ||= `${config.root}/budgets.json`;
}

if (cmd === 'serve') {
  // --demo: la scheda Automazioni legge un modello finto (USAGE_HUB_DEMO_AUTOMATIONS=ok|problemi), il feedback va in una cartella di prova.
  const demoAuto = rest.includes('--demo') ? createDemoAutomations({ fixture: process.env.USAGE_HUB_DEMO_AUTOMATIONS || 'ok' }) : null;
  const portArg = rest.indexOf('--port');
  if (portArg >= 0) config.port = Number(rest[portArg + 1]);
  // --no-live: solo le pagine e le API a richiesta (niente coda che lancia agenti, niente shed, niente avvisi): per misurare
  // la scheda Automazioni con le fonti vere su un'altra porta senza fare un secondo hub.
  const noLive = rest.includes('--no-live');
  if (noLive) config.compatPort = false;
  // --demo è tutta di prova: quote, Mac, agenti, contesto, servizi, «Ti aspetta» e diario finti, e nessun giro vivo (noLive).
  const server = createServer(config, { root: config.root, ...(noLive ? { noLive: true } : {}),
    ...(demoAuto ? { diaryDir: process.env.USAGE_HUB_DIARIO || seedDemoDiary(config.root), museRoot: `${config.root}/muse`, codexRoot: `${config.root}/codex` } : {}),
    ...(demoAuto ? { automations: demoAuto, noQueue: true, noLive: true, demo: true, overview: async () => demoOverview(), demoMac: () => demoMac(), demoAgents: () => demoAgents(), demoContext: () => demoContext(), demoServices: () => demoServices() } : {}) });
  server.listen(config.port, '127.0.0.1', () => console.error(`usage-hub on http://127.0.0.1:${config.port}`));
  // :3337 era il vecchio usage-server, ora dentro il hub: resta in ascolto per gli script che lo leggono ancora
  // (todo-recap, desk_quota, muse-resume). Stesse risposte, stesso processo.
  if (config.compatPort !== false && !rest.includes('--demo')) {
    http.createServer((req, res) => server.emit('request', req, res)).listen(config.compatPort || 3337, '127.0.0.1')
      .on('error', (err) => console.error(`porta di compatibilità non aperta: ${err.message}`));
  }
} else if (cmd === 'feedback') {
  // feedback [--open] [--json]: il giudizio di Attilio sulle automazioni, per gli agenti. Legge i file, non l'hub.
  const state = buildState(readAll().rows);
  const open = openItems(state);
  if (rest.includes('--json')) console.log(JSON.stringify(rest.includes('--open') ? open : [...state].map(([key, s]) => ({ key, ...s, history: undefined })), null, 1));
  else if (rest.includes('--open')) for (const { key, row } of open) console.log(`${row.at.slice(0, 16).replace('T', ' ')}  ${key}  ${row.kind}${row.v ? ' ' + row.v : ''}: ${row.note || ''}  (chiudi con resolve ref=${row.id})`);
  else for (const [key, s] of state) console.log(`${key}  ${s.vote ? s.vote.v : '-'}${s.mute ? '  silenziata' : ''}${s.open.length ? '  aperte ' + s.open.length : ''}`);
} else if (cmd === 'projects') {
  const r = await buildReport(config, { root: config.root });
  console.log(`account ${r.account.label}: ${r.account.weekPct}% of the week`);
  for (const p of r.projects.slice(0, 15)) console.log(`${p.name.padEnd(28)} ${String(p.weekPct).padStart(5)}%  ${p.requests} req${p.subRequests ? `  (subagent ${p.subRequests} req, ${p.subWeekPct}%)` : ''}`);
  if (r.codex) {
    console.log(`\nCodex${r.codex.quota ? ` (quota 7d ${r.codex.quota.weekPct}%)` : ''}:`);
    for (const p of r.codex.projects.slice(0, 10)) console.log(`${p.name.padEnd(28)} ${String(p.weekPct ?? '-').padStart(6)}%  ${p.requests} req`);
  }
  if (r.free) {
    console.log(`\nFree channels (${r.free.requests} req, 0 quota):`);
    for (const [id, c] of Object.entries(r.free.channels)) console.log(`${id.padEnd(28)} ${String(c.requests).padStart(6)} req`);
  }
  if (r.apiSpend) {
    console.log(`\nAPI spend: $${r.apiSpend.today.toFixed(2)} today, $${r.apiSpend.last7d.toFixed(2)} 7d`);
    for (const [key, row] of Object.entries(r.apiSpend.perKey)) console.log(`${key.padEnd(28)} $${row.last7d.toFixed(2).padStart(7)} 7d`);
  }
  if (r.muse) {
    const quota = r.muse.quota ? `, quota 7d ${r.muse.quota.weekPct}%` : '';
    console.log(`\nMuse (unit: ${r.muse.unit}${quota}):`);
    for (const p of r.muse.projects.slice(0, 10)) {
      const share = `${(p.share * 100).toFixed(1)}%`;
      const amount = p.unit === 'tokens' ? `${p.weight} tok` : `${p.weight} turns`;
      console.log(`${p.name.padEnd(28)} ${share.padStart(6)} share  ${amount.padStart(10)}  ${p.requests} req`);
    }
  }
} else if (cmd === 'check') {
  // Stampa solo quando scatta un avviso: pensato per un cron che annuncia lo stdout.
  const report = await buildReport(config, { root: config.root });
  try { report.pace = buildPace(await trayOverview()); } catch { /* tray giù: il ritmo tace, gli altri avvisi no */ }
  const dry = rest.includes('--dry-run');
  // La cache per l'hook di sessione si aggiorna a ogni check (non in dry-run).
  if (!dry) writeStatus(buildStatus(report, config.budgets));
  const fired = await runAlerts(report, config, { dryRun: dry });
  if (dry) for (const e of fired) console.log(`[dry-run] ${e.message}`);
} else if (cmd === 'policy') {
  // policy [--dry-run] [--fake id=valore ...]: valuta tutti i budget; senza --dry-run applica i blocchi.
  const fake = {};
  rest.forEach((a, i) => { if (a === '--fake') { const [k, v] = (rest[i + 1] || '').split('='); fake[k] = v; } });
  const report = await buildReport(config, { root: config.root });
  const policies = config.policies || defaultPolicies(loadBudgets(), loadMuseBudget());
  const results = evaluatePolicies(report, policies, { fake });
  const dry = rest.includes('--dry-run');
  const applied = applyBlocks(results, { dryRun: dry });
  for (const r of results) console.log(`${dry ? '[dry-run] ' : ''}${r.action.toUpperCase()} ${r.message}`);
  if (!results.length) console.log('nessuna policy sopra soglia');
  if (dry && applied.blocked.length) console.log(`[dry-run] bloccherei: ${applied.blocked.join(', ')}`);
} else if (cmd === 'pace') {
  // Ritmo per abbonamento: % usata contro % di settimana trascorsa, e quanto si può spendere al giorno.
  // Le righe sono quelle del gate (/api/pace: copia di 60 s, con l'ultima lettura tenuta se una sonda salta);
  // hub giù = overview della tray. «attivo» = l'account che VDM sta usando.
  const base = `${(config.tray && config.tray.url) || 'http://127.0.0.1:3360'}`;
  let rows;
  try { rows = await (await fetch(`${base}/api/pace`, { signal: AbortSignal.timeout(5000) })).json(); } catch { rows = buildPace(await trayOverview()); }
  for (const r of rows) {
    if (r.unknown) { console.log(`${`${r.provider}/${r.account}`.padEnd(30)} quota non letta`); continue; }
    console.log(`${`${r.provider}/${r.account}`.padEnd(30)} ${String(r.used).padStart(4)}%  settimana ${String(r.elapsedPct).padStart(3)}%  ritmo ${r.pace ?? '-'}  ${r.perDay}%/g  reset ${hhmm(r.resetsAt)}  ${r.status}${r.provider === 'claude' && r.active ? '  attivo' : ''}${r.stale ? '  (lettura vecchia)' : ''}`);
  }
  // Chi prende un lavoro nuovo, per classe: lo stesso gate di delegate e della coda; su Claude anche il modello
  // (modelFor di src/route.mjs: Opus/Sonnet per il gusto, Haiku per il meccanico). L'interattivo è Attilio dal vivo.
  const ov = activeOverrides(loadOverrides());
  const pick = (cls, opts = {}, work = null) => {
    const g = gate(rows, cls, { overrides: ov, ...opts });
    if (!g.go) return 'aspetta';
    const m = work && g.provider === 'claude' ? modelFor(g, work, rows, null, true) : null;
    return `${g.provider}${g.account && g.provider === 'claude' ? `/${g.account}` : ''}${m ? ` ${m.model}${m.effort ? ` ${m.effort}` : ''}` : ''}`;
  };
  console.log(`\nlavoro nuovo: interattivo → ${pick('interattivo')} · gusto → ${pick('gusto', {}, 'taste')} · meccanico con strumenti → ${pick('massivo', { skip: ['free'] }, 'mechanical')} · differibile → ${pick('batch', { skip: ['free'] }, 'mechanical')}`);
  for (const o of ov) console.log(`override: ${o.provider}${o.class ? `/${o.class}` : ''} fino a ${hhmm(o.until)}, da ${o.by}: ${o.reason}`);
} else if (cmd === 'allow') {
  // allow <provider> [--hours N] [--class X] --by CHI --reason PERCHÉ | --list | --revoke <provider>
  // Toglie solo il freno di pacing a tempo; quota esaurita, finestra 5h e riserva restano.
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  if (rest.includes('--list')) {
    const act = activeOverrides(loadOverrides());
    if (!act.length) console.log('nessun override attivo');
    for (const o of act) console.log(`${o.provider}${o.class ? `/${o.class}` : ''} fino a ${hhmm(o.until)}, da ${o.by}: ${o.reason}`);
  } else if (rest.includes('--revoke')) {
    console.log(`revocati ${revokeOverride(val('--revoke'))} override`);
  } else {
    try {
      const o = addOverride({ provider: rest.find((a, i) => !a.startsWith('--') && !['--hours', '--class', '--by', '--reason'].includes(rest[i - 1])), hours: val('--hours') ? Number(val('--hours')) : 12, cls: val('--class') || null, by: val('--by'), reason: val('--reason') });
      console.log(`override ${o.provider}${o.class ? `/${o.class}` : ''} attivo fino a ${hhmm(o.until)} (da ${o.by})`);
    } catch (err) { console.error(err.message); process.exit(2); }
  }
} else if (cmd === 'gate') {
  // gate <classe> [--skip free] [--reserve 10] [--json]: exit 0 = vai (stampa provider), 10 = aspetta.
  const cls = rest.find((a, i) => !a.startsWith('--') && !['--skip', '--reserve', '--provider', '--project'].includes(rest[i - 1]));
  const pj = rest.indexOf('--project');
  // Priorità e budget del progetto dalla copia del server (veloce); server giù = si decide senza progetto.
  let project = null;
  if (pj >= 0) {
    try {
      const live = await (await fetch(`http://127.0.0.1:${config.port || 3360}/api/live`, { signal: AbortSignal.timeout(3000) })).json();
      project = live.projects.find((p) => p.name === rest[pj + 1]) || { name: rest[pj + 1], priority: 'normale', total: 0, budgetPct: null };
    } catch { console.error('gate: hub :3360 non letto, decido senza priorità di progetto'); }
  }
  const pi = rest.indexOf('--provider');
  const skip = rest.flatMap((a, i) => (a === '--skip' ? (rest[i + 1] || '').split(',') : []));
  const ri = rest.indexOf('--reserve');
  // Contatore giù o lento: il freno lascia passare (exit 0) e lo dice su stderr, mai un lavoro fermo per il contatore.
  let ov;
  try { ov = await trayOverview(); } catch (err) { console.error(`gate: contatore :3360 non letto (${err.name}), lascio passare`); process.exit(0); }
  const g = gate(buildPace(ov), cls, { skip, reserve: ri >= 0 ? Number(rest[ri + 1]) : 10, provider: pi >= 0 ? rest[pi + 1] : null, project, overrides: activeOverrides(loadOverrides()) });
  if (g.override) console.error(`gate: override attivo su ${g.override.provider}, dato da ${g.override.by} fino a ${hhmm(g.override.until)} (${g.override.reason})`);
  if (rest.includes('--json')) console.log(JSON.stringify(g));
  else console.log(g.go ? `vai: ${g.provider}${g.account ? `/${g.account}` : ''} (${g.reason})` : `aspetta${g.waitUntil ? ` fino a ${hhmm(g.waitUntil)}` : ''}: ${g.reason}`);
  process.exit(g.go ? 0 : 10);
} else if (cmd === 'refresh') {
  // Solo la cache, nessun avviso: lo lancia l'hook quando i dati sono vecchi.
  writeStatus(buildStatus(await buildReport(config, { root: config.root }), config.budgets));
} else {
  console.error('usage: usage-hub serve | projects | check [--dry-run] | policy [--dry-run] [--fake id=n] | pace | allow <provider> [--hours N] [--class X] --by CHI --reason PERCHÉ | allow --list | allow --revoke <provider> | gate <interattivo|gusto|massivo|batch> [--provider codex|muse|claude] [--project NOME] [--skip free] [--reserve 10] [--json] | refresh');
  process.exit(2);
}
