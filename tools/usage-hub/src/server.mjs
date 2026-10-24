import { graphFor } from './automations/graph.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildReport } from './projects.mjs';
import { createClaudeTracker } from './usage.mjs';
import { createCodexTracker } from './codex.mjs';
import { createMuseTracker } from './muse.mjs';
import { createProxyFeed } from './vdm.mjs';
import { overview as trayOverview } from '../modules/tray/server/server.mjs';
import { servicesSnapshot } from './services.mjs';
import { evaluateRules } from './alerts.mjs';
import { defaultPolicies, evaluatePolicies } from './policy.mjs';
import { loadBudgets, loadMuseBudget } from './budgets.mjs';
import { ROOT } from './config.mjs';
import { loadOverrides, activeOverrides, addOverride, revokeOverride, addHold, revokeHold } from './overrides.mjs';
import { forecast, headline } from './forecast.mjs';
import { buildPace, carryLastReading, gate, CLASSES, providerStates, projectState } from './pacing.mjs';
import { route } from './route.mjs';
import { enqueue, cancel, loadQueue, tick, recoverRunning, launchDelegate, createNotifier, sendWhatsApp } from './queue.mjs';
import { newState, scanToday } from './sessions.mjs';
import { projectSummary, saveProjectSetting, loadLabels, labelFor, explainProjects } from './live.mjs';
import { scanAgents, summarize, attachOpen, loadDesktopSessions, topicsByProject } from './agents.mjs';
import { attachSessionUse, shareFromReport } from './session-use.mjs';
import { demoVdm } from './demo-vdm.mjs';
import { macMachine, pcMachine, offloadJobs } from './machines.mjs';
import https from 'node:https';
import { createMacWatch, attachResources } from './macwatch.mjs';
import { createShed, createShedDigest } from './shed.mjs';
import { createTrust, createTrustAlert } from './trust.mjs';
import { topHogs, processTable } from './mac.mjs';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { makeResolver, readCronNames } from './openclaw.mjs';
import { createAutomations, findRunFile, workflowRunCost } from './automations/index.mjs';
import { validate as validateFeedback } from './automations/feedback.mjs';
import { operatore } from './operatore.mjs';
import { readAttesa, writeAttesa, validateAttesa, fromAutomations } from './attesa.mjs';
import { journal, readDiary, appendDiary } from './journal.mjs';
import { fixTask } from './fix.mjs';
import { readAll as readFeedback } from './automations/feedback.mjs';
import { localConfig } from './local-config.mjs';

// Giri che toccano il mondo (coda che lancia agenti, avvisi WhatsApp, riavvio del gateway, pausa dei processi, diario):
// solo nell'hub vero. Test, --no-live e --demo non devono poter scrivere ad Attilio né fermare un processo.
export const liveJobs = (deps = {}) => !deps.noLive && !deps.inProcess && !deps.demo;

export function createServer(config, deps = {}) {
  // Nei test (fetch finto o root di prova) il report si calcola nel processo, come prima.
  deps = { ...deps, inProcess: deps.inProcess ?? !!(deps.fetchImpl || deps.root) };
  const runsLive = liveJobs(deps);
  // Progetti per la tray: ricalcolo in background ogni 5 minuti (CPU, zero token), la richiesta legge la copia.
  let live = { at: 0, projects: [], computing: false };
  const refreshLive = async () => {
    if (live.computing) return;
    live.computing = true;
    try { cache = deps.inProcess ? await buildReport(config, deps) : await buildReport(config, { ...deps, root: config.root, trackers, fetchImpl: hubFetch }); live = { at: cache.at, projects: projectSummary(cache, loadBudgets(), { labels: loadLabels(), top: Infinity }), computing: false }; }
    catch (err) { live = { ...live, error: err.message, computing: false }; }
  };
  if (runsLive) { setImmediate(refreshLive); setInterval(refreshLive, (config.liveEveryMin || 5) * 60000).unref(); }
  // la demo calcola i suoi progetti finti una volta, così la tabella dei progetti ha i numeri (e la barra UI li controlla)
  else if (deps.demo) setImmediate(refreshLive);
  let cache = null;
  let svcCache = null; // scheda Servizi: calcolata a richiesta, valida un minuto
  let pcCache = null;  // PC di casa (~/bin/pc-state): valido un minuto, ogni lettura e' un nc e al piu' un ssh di pochi ms
  // Prima il report girava in un figlio ogni 5 minuti e rileggeva l'intera settimana (325 MB, 5 s di CPU).
  // Ora i tracker restano vivi qui e leggono solo i byte aggiunti; il primo giro cede il loop ogni 20 file.
  const trackers = { claude: createClaudeTracker(), codex: createCodexTracker(), muse: createMuseTracker(), proxy: createProxyFeed() };
  // Le quote di tutti i provider (prima il processo a parte usage-server su :3337): una sola overview in volo,
  // copia di 45 s. hubFetch risponde in casa alle URL /api/overview, così quota.mjs e il ritmo non escono dal processo.
  let ovCache = { at: 0, body: null }; let ovInflight = null;
  const overviewJson = async () => {
    if (!ovCache.body || Date.now() - ovCache.at > 45000) {
      ovInflight ||= (deps.overview || trayOverview)().then((o) => { ovCache = { at: Date.now(), body: JSON.stringify(o) }; }).finally(() => { ovInflight = null; });
      await ovInflight;
    }
    return ovCache.body;
  };
  const local = !deps.inProcess || deps.overview;
  const hubFetch = (url, opts) => (local && String(url).endsWith('/api/overview')
    ? overviewJson().then((body) => new Response(body, { headers: { 'content-type': 'application/json' } }))
    : (deps.fetchImpl || fetch)(url, opts));
  const report = async () => {
    if (deps.inProcess) { if (!cache || Date.now() - cache.at > 30000) cache = await buildReport(config, deps); return cache; }
    if (!cache) await refreshLive();
    if (!cache) throw new Error(live.error || 'report non ancora pronto');
    return cache;
  };
  // Quote per pace/gate/route: copia di 60 s, scaduta si usa lo stesso e si rinfresca dietro
  // (sotto carico l'overview della tray costa decine di secondi, la delega non può aspettarla).
  let paceCache = null; let paceInflight = null;
  const fetchRows = () => (paceInflight ||= hubFetch(`${(config.tray && config.tray.url) || 'http://127.0.0.1:3360'}/api/overview`, { signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).then((o) => { paceCache = { at: Date.now(), rows: carryLastReading(buildPace(o), paceCache && paceCache.rows) }; return paceCache.rows; })
    .finally(() => { paceInflight = null; }));
  if (runsLive) setImmediate(() => fetchRows().catch(() => {}));
  async function paceRows() {
    if (!paceCache) return fetchRows();
    if (Date.now() - paceCache.at > 60000) fetchRows().catch(() => {});
    return paceCache.rows;
  }
  // Coda dei lavori frenati: riprova ogni 5 minuti, avvisi WhatsApp raggruppati (max uno ogni 15).
  // Diario dell'hub: dettagli di coda, freno e processi sospetti. In test e demo non si scrive niente su disco.
  const diary = deps.writeDiary || (runsLive ? (r) => appendDiary(r) : () => {});
  const notifier = createNotifier({ diary });
  const queueTick = () => tick({
    routeFn: async (item) => {
      const info = (live.projects || []).find((p) => p.name === item.project) || null;
      return route(await paceRows(), item.task, { project: item.project, projectInfo: info, cls: item.cls, writer: item.writer || '', overrides: activeOverrides(loadOverrides()), ...(deps.classify ? { classify: deps.classify } : {}) });
    },
    launch: (item, done) => launchDelegate(item, done, { bin: path.join(ROOT, 'bin', 'delegate') }),
    projectOf: (name) => (live.projects || []).find((p) => p.name === name) || null,
    notify: (line) => notifier.push(line),
  }).then(() => notifier.flush()).catch(() => {});
  // noQueue: in demo la coda è di prova e nessuno deve lanciarne i lavori
  if (runsLive && !deps.noQueue) {
    recoverRunning();
    setInterval(queueTick, (config.queueEveryMin || 5) * 60000).unref();
    setInterval(() => notifier.flush(), 60000).unref();
  }
  // Sessioni che hanno consumato di più oggi: scansione incrementale dei transcript ogni 5 minuti.
  const sessState = newState(); let heavySessions = [];
  const scanSessions = () => scanToday(sessState).then((r) => { heavySessions = r; }).catch(() => {});
  if (runsLive) { setImmediate(scanSessions); setInterval(scanSessions, 5 * 60000).unref(); }
  // Mac sotto sforzo: misura ogni 30 s; se serve ferma gli agenti in background (mai le sessioni aperte) e li riprende da solo.
  const priorityOf = (name) => ((live.projects || []).find((p) => p.name === name) || {}).priority || 'normale';
  let macShed = null;
  // L'indice delle sessioni OpenClaw (SQLite + nomi dei cron) si ricostruisce al più ogni 2 min: serve allo shed per
  // distinguere un sottoagente da un turno di chat, che non va mai messo in pausa.
  let ocRes = { at: 0, v: null };
  const openclawResolve = async () => {
    if (Date.now() - ocRes.at > 120000) { try { // i nomi dei cron chiedono la CLI di OpenClaw, che col Mac carico ci mette minuti: non si aspetta oltre 2 s,
      // per dire chat o sottoagente basta l'indice SQLite
      const cronNames = await Promise.race([readCronNames(), new Promise((r) => setTimeout(() => r(null), 2000).unref())]);
      ocRes = { at: Date.now(), v: (await makeResolver(config.openclaw || {}, { cronNames: cronNames || {} })).resolve }; } catch { ocRes = { at: Date.now(), v: null }; } }
    return ocRes.v;
  };
  const macWatch = createMacWatch({ groups: config.groups || [], priorityOf, getShed: () => macShed, openclawResolve });
  // Attendibilità dei processi: un giro ogni 2 minuti (≈0,1 s con le firme in cache), i gravi su WhatsApp una volta al giorno
  const trust = createTrust({ allow: (config.trust && config.trust.allow) || [] });
  const trustAlert = createTrustAlert({ send: deps.sendNotice || sendWhatsApp, diary, file: !runsLive ? null : path.join(os.homedir(), '.cache', 'claude-usage-hub', 'trust-alerts.json') });
  const trustTick = () => trust.scan().then((r) => trustAlert(r.items)).then((n) => { if (n) console.log(`[trust] avviso WhatsApp: ${n} processi sospetti`); }).catch(() => {});
  if (runsLive) { setTimeout(trustTick, 15000).unref(); setInterval(trustTick, 120000).unref(); }
  const shedDigest = createShedDigest({
    send: deps.sendNotice || sendWhatsApp, diary, log: (l) => console.log('[shed] ' + l), hogs: async () => topHogs(await processTable(), 5),
    // i giri di `offload` finiti sul PC (una riga per giro in ~/.cache/offload/runs.jsonl, la scrive offload stesso)
    offloads: async (from, to) => { try { return fs.readFileSync(path.join(os.homedir(), '.cache', 'offload', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.at >= from && r.at <= to); } catch { return []; } },
    // oc-restart senza opzioni non taglia turni: se il gateway lavora si stacca e riavvia appena è libero (max 6 h)
    restartGateway: deps.restartGateway || (async () => { const { spawn } = await import('node:child_process'); const bin = path.join(os.homedir(), 'bin', 'oc-restart'); if (!fs.existsSync(bin)) return false;
      const out = fs.openSync(path.join(os.homedir(), '.claude', 'jarvis', 'state', `oc-restart-hub-${Date.now()}.log`), 'w');
      spawn(bin, [], { detached: true, stdio: ['ignore', out, out] }).unref(); return true; }),
    // server figli del gateway MCP con la memoria vera del loro albero, e il rimontaggio (mcpgw.mjs)
    mcpChildren: async () => {
      const { mcpChildren } = await import('./mcpgw.mjs'), { descendants, footprintMap } = await import('./mac.mjs');
      const [kids, table] = await Promise.all([mcpChildren(), processTable()]);
      const trees = kids.map((k) => descendants(table, k.pid).map((r) => r.pid));
      const fp = await footprintMap(trees.flat());
      return kids.map((k, i) => ({ ...k, memMB: trees[i].reduce((a, p) => a + (fp.get(p) || 0), 0) }));
    },
    remountMcp: async (name) => (await import('./mcpgw.mjs')).remountMcp(name),
  });
  macShed = createShed({ probe: macWatch.probe, log: (l) => console.log('[shed] ' + l), onEvent: (e) => shedDigest.event(e), enabled: Boolean(config.shed && config.shed.enabled === true) });
  // La pausa degli agenti è spenta salvo `shed.enabled: true` (24/10): il 23/10 13 pause su 13 hanno colpito agenti che
  // non pesavano, e chi bloccava (server TypeScript 3 GB, wigolo 5,9 GB, gateway OpenClaw) non è un agente fermabile.
  // Resta la misura: il riepilogo dice chi blocca e perché.
  if (runsLive) {
    macShed.thawAll('avvio del hub').catch(() => {});
    const shedTick = () => macShed.tick().then((st) => shedDigest.tick(st)).catch(() => {});
    setInterval(shedTick, 30000).unref(); setInterval(() => shedDigest.flush().catch(() => {}), 60000).unref(); setTimeout(shedTick, 2000).unref();
    // Spegnendo il hub niente resta fermo: un processo in SIGSTOP per sempre è peggio del carico.
    for (const sg of ['SIGTERM', 'SIGINT']) process.on(sg, () => { macShed.thawAll('spegnimento del hub').finally(() => process.exit(0)); });
  }
  // Agenti vivi: solo stat() e code dei file, cache 45 s così aprire il menu non rifà la scansione.
  // Ultima attività per progetto su 7 giorni (serve a dire «fermo da quanto, e perché»): ogni 10 minuti, i cwd sono in memoria.
  // I tab Topics aperti (terminali con sessione Topics) servono per aprire una sessione o proporre la chat del progetto.
  const topicsTerminals = () => new Promise((resolve) => {
    let ca; try { ca = fs.readFileSync(path.join(os.homedir(), 'Projects/topics-app/certs/ca-cert.pem')); } catch { return resolve([]); }
    const req = https.get('https://127.0.0.1:3333/api/live-terminals', { ca, timeout: 3000, checkServerIdentity: () => undefined }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { resolve(JSON.parse(b).terminals || []); } catch { resolve([]); } });
    });
    req.on('error', () => resolve([])); req.on('timeout', () => { req.destroy(); resolve([]); });
  });
  let agentCache = { at: 0, v: { agents: [], lastSeen: {}, topics: {} } }; let weekSeen = { at: 0, v: {} };
  // Copia sempre pronta: scaduta (45 s) si risponde con quella e si riscansiona dietro; si aspetta solo la prima volta.
  // Col Mac carico la scansione a freddo costava fino a 9 s alla Panoramica (verifica del 24/10).
  let agentScan = null, agentReady = false;
  const liveAgents = async (queue) => {
    if (deps.demoAgents) return { agents: deps.demoAgents(), lastSeen: {}, topics: {} };
    if (agentReady && Date.now() - agentCache.at < 45000) return agentCache.v;
    agentScan ||= scanLiveAgents(queue).then(() => { agentReady = true; }).catch(() => {}).finally(() => { agentScan = null; });
    if (!agentReady) await agentScan;
    return agentCache.v;
  };
  const scanLiveAgents = async (queue) => {
    const groups = config.groups || [];
    const resolve = await openclawResolve();
    if (Date.now() - weekSeen.at > 10 * 60000) weekSeen = { at: Date.now(), v: scanAgents({ groups, seenDays: 7, resolve }).lastSeen };
    // deps.scanAgents: i test passano gli agenti, così arrivano qui (quota per sessione) senza toccare il Mac vero
    const { agents, lastSeen } = (deps.scanAgents || scanAgents)({ groups, queue, resolve });
    const terminals = deps.scanAgents ? [] : await topicsTerminals();
    if (!deps.scanAgents) {
      attachOpen(agents, { desktop: loadDesktopSessions(), topics: terminals.filter((t) => t.source === 'topics') });
      try { attachResources(agents, (await macWatch.snapshot()).trees); } catch { /* senza misure le righe restano senza risorse */ }
    }
    // quanto consuma ogni sessione: dai tracker che l'hub aggiorna già per i progetti
    attachSessionUse(agents, trackers, cache, { weights: config.weights });
    agentCache = { at: Date.now(), v: { agents, lastSeen: { ...weekSeen.v, ...lastSeen }, topics: topicsByProject(terminals, { groups, ocRoot: path.join(os.homedir(), '.openclaw') }) } };
    return agentCache.v;
  };
  if (runsLive) { setTimeout(() => liveAgents(loadQueue()).catch(() => {}), 3000).unref(); setInterval(() => liveAgents(loadQueue()).catch(() => {}), 40000).unref(); }
  // Automazioni: fonti lette a richiesta con copia di 60 s; GitHub e PC solo in background (mai nel percorso della richiesta).
  // Nei test e in --demo si crea alla prima richiesta; nell'hub vivo subito, così GitHub e PC partono col primo giro dietro.
  let autoApi = null;
  const auto = () => (autoApi ||= deps.automations || createAutomations({ background: runsLive }));
  if (runsLive) auto();
  // Quota della settimana di un costo pesato (sessione, giro di workflow), con la stessa divisione dei progetti.
  // La divisione sta in session-use.mjs (shareFromReport, attachSessionUse), testata col report vero.
  const weekShare = (weighted) => shareFromReport(cache, 'claude', weighted);
  // «Da cambiare» passa a un agente: una voce in coda con la nota e il modo di chiuderla.
  const changeRequest = (row, card) => enqueue({
    task: `Automazione «${(card && card.title) || row.key}» (${row.key}): Attilio ha detto «da cambiare». La sua nota: «${row.note}». ` +
      `Cambiala come chiede (descrizioni in ~/.claude/jarvis/private/automazioni/descrizioni.json, feedback con: node ~/.claude/jarvis/tools/usage-hub/bin/usage-hub.mjs feedback --open).` +
      `Quando hai finito chiudi la richiesta: curl -s -X POST http://127.0.0.1:3360/api/feedback -H 'content-type: application/json' -d '{"kind":"resolve","ref":"${row.id}","commit":"<sha o file cambiato>"}'. ` +
      `Se l'automazione cambia id o sistema scrivi anche {"kind":"migration","from":"${row.key}","to":"<chiave nuova>"}.`,
    dir: row.key.startsWith('cron:') ? path.join(os.homedir(), '.openclaw') : path.join(os.homedir(), '.claude', 'jarvis'),
    project: 'automazioni',
  });
  // pc-state non sveglia il PC e non lo tiene sveglio; senza risposta in 10 s il PC e' "sconosciuto". Copia di 60 s.
  const pcState = async () => {
    if (!pcCache || Date.now() - pcCache.at > 60000) {
      const data = await new Promise((resolve) => execFile(path.join(os.homedir(), 'bin', 'pc-state'), { timeout: 10000 }, (err, out) => {
        try { resolve(JSON.parse(String(out))); } catch { resolve({ pc: 'sconosciuto', perche: err ? err.message : 'risposta illeggibile', avviso: false }); }
      }));
      pcCache = { at: Date.now(), data };
    }
    return pcCache.data;
  };
  // Pagina Contesto: report in copia di 60 s; contraddizioni da un agente, salvate in un file di cache.
  let ctxCache = null;
  // agents-doctor ci mette secondi (minuti col Mac carico): gira dietro, la pagina usa l'ultimo esito o dice «in corso».
  let doctorLast = null; let doctorBusy = null;
  const doctorCached = async () => {
    if (!doctorBusy && (!doctorLast || Date.now() - doctorLast.at > 5 * 60000)) {
      const run = (deps.contextOpts && deps.contextOpts.runDoctor) || (await import('./context.mjs')).defaultDoctor;
      doctorBusy = run().then((r) => { doctorLast = { at: Date.now(), r }; ctxCache = null; }).finally(() => { doctorBusy = null; });
    }
    if (deps.contextOpts && deps.contextOpts.runDoctor && doctorBusy) await doctorBusy; // nei test: l'esito subito
    return doctorLast ? doctorLast.r : { code: null, stdout: '', pending: true };
  };
  const checkFile = () => process.env.USAGE_HUB_CONTEXT_CHECK || path.join(os.homedir(), '.cache', 'claude-usage-hub', 'context-check.json');
  const readCheck = () => { try { return JSON.parse(fs.readFileSync(checkFile(), 'utf8')); } catch { return { at: null, items: [] }; } };
  const writeCheck = (o) => { fs.mkdirSync(path.dirname(checkFile()), { recursive: true }); fs.writeFileSync(checkFile(), JSON.stringify(o)); };
  const startCheck = (files) => {
    const prev = readCheck();
    writeCheck({ ...prev, running: true, startedAt: Date.now() });
    const prompt = `Leggi questi file di istruzioni per agenti: ${files.join(', ')}. Cerca le contraddizioni: due regole, nello stesso file o in file diversi, che chiedono cose opposte sullo stesso tema (non doppioni, non sfumature). ` +
      'Rispondi SOLO con una riga JSON, niente altro: {"items":[{"a":{"file":"<percorso con ~>","text":"<la regola, max 160 caratteri>"},"b":{"file":"…","text":"…"},"why":"<perché si contraddicono, una frase>"}]}. Al massimo 10 voci; nessuna contraddizione = {"items":[]}. Non riportare numeri di telefono né email.';
    execFile(path.join(ROOT, 'bin', 'delegate'), ['--class', 'taste', '-C', os.homedir(), prompt], { timeout: 15 * 60000, maxBuffer: 4 << 20 }, (err, out) => {
      const m = String(out || '').match(/\{"items":\s*\[[\s\S]*\]\s*\}/);
      let items = null; try { items = m ? JSON.parse(m[0]).items : null; } catch { items = null; }
      writeCheck(items ? { at: Date.now(), items, running: false } : { ...prev, running: false, error: err ? err.message.slice(0, 200) : 'risposta senza JSON', failedAt: Date.now() });
    });
  };
  let compName = null;
  const computerName = () => {
    if (compName == null) { try { compName = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 2000 }).toString().trim(); } catch { compName = ''; } }
    return compName || os.hostname().replace(/\.local$/, '');
  };
  return http.createServer(async (req, res) => {
    // no-cache: la dashboard si aggiorna con il repo, il browser non deve tenersi app.js vecchi (rivalida, non riscarica).
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' }); res.end(body); };
    // Le scritture (coda che lancia agenti, override, stop, proxy VDM) solo da questa macchina: una pagina web qualsiasi può fare
    // POST a 127.0.0.1, ma il browser ci mette la sua Origin. curl, la tray e la dashboard stessa passano.
    // Anche la porta su cui gira questo server: la dashboard di un serve --demo o --port scrive su sé stessa.
    const own = new RegExp(`^http://(127\\.0\\.0\\.1|localhost):(3360|3337|${Number(config.port) || 3360})$`);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && !own.test(req.headers.origin)) {
      return send(403, 'application/json', JSON.stringify({ error: 'scrittura rifiutata: origine esterna ' + req.headers.origin }));
    }
    const readJson = async () => { let b = ''; for await (const c of req) b += c; return JSON.parse(b || '{}'); };
    try {
      if (req.url === '/api/live') {
        // Lo stato di ogni progetto (frenato, in coda, attivo, fermo) si calcola qui con lo stesso gate di route.
        let rows = []; try { rows = await paceRows(); } catch { /* senza quote niente stato */ }
        const queue = loadQueue();
        let projects = live.projects.map((p) => (rows.length ? { ...p, ...projectState(rows, p, queue) } : p));
        // Agenti vivi per progetto; i progetti con agenti ma fuori dal report entrano come righe in più, quelli con agenti vengono per primi.
        const { agents, lastSeen, topics } = await liveAgents(queue); const sum = summarize(agents);
        const names = new Set(projects.map((p) => p.name));
        for (const n of Object.keys(sum)) if (!names.has(n)) projects.push({ name: n, claude: 0, codex: 0, muse: 0, total: 0, budgetPct: null, priority: 'normale', label: null, title: labelFor(n, loadLabels()).label || n, what: labelFor(n, loadLabels()).what || '', state: 'attivo', why: '', waitUntil: null });
        const lastJob = (n) => queue.filter((q) => q.project === n && (q.status === 'done' || q.status === 'failed')).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0];
        const week = 7 * 86400000, nowMs = Date.now();
        const missing = (n) => !!(lastSeen[n] && lastSeen[n].cwd && !fs.existsSync(lastSeen[n].cwd));
        projects = projects.map((p) => ({ ...p, agents: sum[p.name] || null, lastSeen: lastSeen[p.name] ? { at: lastSeen[p.name].at, provider: lastSeen[p.name].provider } : null,
          // «morto»: niente agenti e niente attività né consumo da 7 giorni, oppure la cartella dove lavorava non esiste più
          dirMissing: missing(p.name),
          dead: !sum[p.name] && (missing(p.name) || ((!lastSeen[p.name] || nowMs - lastSeen[p.name].at > week) && !(p.total > 0))),
          topics: topics[p.name] || [], lastJob: (lastJob(p.name) && { task: lastJob(p.name).task.slice(0, 60), status: lastJob(p.name).status, endedAt: lastJob(p.name).endedAt }) || null }));
        projects = explainProjects(projects, (p) => sum[p.name]?.list.find((a) => a.cwd)?.cwd || lastSeen[p.name]?.cwd);
        // Il riepilogo tiene tutti i progetti: tagliarlo ai primi 8 faceva rientrare a zero quelli con agenti vivi
        // (l'hub stesso al 2,4% compariva con «–»). Si mostrano i primi 8 per consumo più chi ha agenti o un budget.
        const top = new Set([...projects].sort((a, b) => b.total - a.total).slice(0, 8).map((p) => p.name));
        projects = projects.filter((p) => p.agents || p.budgetPct != null || top.has(p.name))
          .sort((a, b) => ((b.agents ? b.agents.count : 0) > 0) - ((a.agents ? a.agents.count : 0) > 0));
        return send(200, 'application/json', JSON.stringify({ at: live.at, projects, error: live.error || null }));
      }
      // Budget e priorità di un progetto dalla tray: {name, budgetPct?, priority?}
      if (req.url === '/api/project-settings' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { name, budgetPct, priority } = JSON.parse(body || '{}');
        const saved = saveProjectSetting(name, { budgetPct, priority });
        if (cache) live = { ...live, projects: projectSummary(cache, loadBudgets(), { labels: loadLabels(), top: Infinity }) };
        return send(200, 'application/json', JSON.stringify({ ok: true, name, saved }));
      }
      // Coda: POST {task, dir, project, cls, priority, waitUntil} accoda · GET elenca · DELETE ?id= toglie un lavoro in attesa
      if (req.url.startsWith('/api/queue')) {
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const item = enqueue(JSON.parse(body || '{}'));
          notifier.push(`in coda ${item.id} (${item.project || '-'}): ${item.task.slice(0, 60)}`);
          return send(200, 'application/json', JSON.stringify(item));
        }
        if (req.method === 'DELETE') return send(200, 'application/json', JSON.stringify({ ok: cancel(new URL(req.url, 'http://x').searchParams.get('id')) }));
        return send(200, 'application/json', JSON.stringify({ items: loadQueue() }));
      }
      // Per la tray: abbonamenti che oggi bruciano oltre la quota giornaliera + le sessioni che consumano di più.
      if (req.url === '/api/heavy') {
        const now = Date.now();
        const over = (await paceRows()).filter((r) => r.used < 100 && r.last24h != null && r.last24h > r.perDay && r.resetsAt - now >= 86400000)
          .map((r) => ({ provider: r.provider, account: r.account, last24h: r.last24h, perDay: r.perDay }));
        const today = (await paceRows()).filter((r) => r.used < 100 && r.last24h != null)
          .map((r) => ({ provider: r.provider, account: r.account, last24h: r.last24h, perDay: r.perDay, used: r.used }));
        return send(200, 'application/json', JSON.stringify({ over, today, sessions: heavySessions }));
      }
      if (req.url === '/api/automations') return send(200, 'application/json', JSON.stringify(await auto().model()));
      // Schema a passi di una voce, chiesto quando apri il pannello: legge definizione, script e log.
      if (req.url.startsWith('/api/automations/graph?')) {
        const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
        let card = null; try { card = ((await auto().model()).cards || {})[key] || null; } catch { /* senza modello: solo la definizione */ }
        const g = deps.demo && auto().graph ? await auto().graph(key) : graphFor(key, { card });
        return send(g ? 200 : 404, 'application/json', JSON.stringify(g || { ok: false, error: 'nessuno schema per questa voce' }));
      }
      if (req.url === '/api/automations/summary') return send(200, 'application/json', JSON.stringify(await auto().summary()));
      // Costo di un giro di workflow, chiesto solo quando lo apri: legge le trascrizioni dei suoi agenti.
      if (req.url.startsWith('/api/automations/run/')) {
        const file = findRunFile(decodeURIComponent(req.url.slice('/api/automations/run/'.length)), deps.projectsDir);
        if (!file) return send(404, 'application/json', JSON.stringify({ ok: false, error: 'giro non trovato' }));
        return send(200, 'application/json', JSON.stringify(workflowRunCost(file, weekShare)));
      }
      // Feedback sulle automazioni: append-only, l'hub è l'unico che scrive. GET ?open=1 per gli agenti.
      if (req.url.startsWith('/api/feedback')) {
        if (req.method === 'POST') {
          const b = await readJson();
          const err = validateFeedback({ by: operatore(), src: 'hub', ...b });
          if (err) return send(400, 'application/json', JSON.stringify({ error: err }));
          const row = auto().feedback(b);
          let queued = null;
          if (row.kind === 'vote' && row.v === 'cambia') {
            let card = null; try { card = ((await auto().model()).cards || {})[row.key] || null; } catch { /* senza modello il titolo è la chiave */ }
            queued = changeRequest(row, card);
          }
          return send(200, 'application/json', JSON.stringify({ ok: true, row, queued }));
        }
        const open = /[?&]open=1/.test(req.url);
        return send(200, 'application/json', JSON.stringify(open ? auto().openFeedback() : { open: auto().openFeedback().length }));
      }
      // «Ti aspetta»: GET le voci aperte (registro + cancelli dei workflow), POST apre o chiude ({kind:'chiudi', ref}).
      if (req.url === '/api/attesa') {
        if (req.method === 'POST') {
          const b = await readJson();
          const err = validateAttesa(b);
          if (err) return send(400, 'application/json', JSON.stringify({ error: err }));
          return send(200, 'application/json', JSON.stringify({ ok: true, row: writeAttesa(b) }));
        }
        let model = null; try { model = await auto().model(); } catch { /* senza automazioni restano le voci del registro */ }
        const items = [...readAttesa(), ...fromAutomations(model)].sort((a, b) => a.at - b.at);
        return send(200, 'application/json', JSON.stringify({ at: Date.now(), items }));
      }
      // Diario: ?days=N (max 30). Tutto ciò che è successo, già in parole.
      if (req.url.startsWith('/api/diario')) {
        const days = Math.min(30, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 7));
        let model = null; try { model = await auto().model(); } catch { /* il diario mostra il resto */ }
        let fb = []; try { fb = readFeedback(deps.feedbackDir ? { dir: deps.feedbackDir } : {}).rows; } catch { /* registro illeggibile */ }
        return send(200, 'application/json', JSON.stringify({ at: Date.now(), days, items: journal({ model, queue: loadQueue(), feedback: fb, diary: readDiary({ days, ...(deps.diaryDir ? { dir: deps.diaryDir } : {}) }), days }) }));
      }
      // Risolvi tu: {key} → un lavoro in coda con il contesto della voce; parte subito se freno e ritmo lo permettono.
      if (req.url === '/api/fix' && req.method === 'POST') {
        const { key } = await readJson();
        let card = null; try { card = ((await auto().model()).cards || {})[key] || null; } catch { /* sotto */ }
        if (!card) return send(404, 'application/json', JSON.stringify({ error: 'voce non trovata: ' + key }));
        const busy = loadQueue().find((q) => q.ref === key && (q.status === 'queued' || q.status === 'running'));
        if (busy) return send(200, 'application/json', JSON.stringify({ ok: true, item: busy, already: true }));
        const item = enqueue(fixTask(card));
        notifier.push(`Risolvi tu ${item.id}: ${card.title}`);
        if (runsLive && !deps.noQueue) setImmediate(queueTick);
        return send(200, 'application/json', JSON.stringify({ ok: true, item }));
      }
      // Impostazioni della pagina che stanno nella config locale (fuori dal repo): i link per scrivere a Jarvis.
      if (req.url === '/api/hub-config') {
        // in demo i bottoni «Scrivi a Jarvis» puntano a link d'esempio: il numero vero di config.local non esce mai
        const jv = deps.demo ? { whatsapp: 'https://esempio.it/assistente/whatsapp', discord: 'https://esempio.it/assistente/discord' } : localConfig().jarvis || {};
        return send(200, 'application/json', JSON.stringify({ demo: !!deps.demo, jarvis: { whatsapp: jv.whatsapp || null, discord: jv.discord || null } }));
      }
      // Contesto: cosa leggono gli agenti. Sola lettura, copia di 60 s (il doctor ci mette qualche secondo).
      if (req.url === '/api/contesto') {
        if (deps.demoContext) return send(200, 'application/json', JSON.stringify({ ...deps.demoContext(), contradictions: { at: null, items: [] } }));
        if (!ctxCache || Date.now() - ctxCache.at > 60000) {
          const { contextReport } = await import('./context.mjs');
          const res = await doctorCached();
          const body = await contextReport({ ...(deps.contextOpts || {}), runDoctor: async () => res });
          if (res.pending) body.doctor = { ok: false, checks: [], error: null, pending: true };
          ctxCache = { at: Date.now(), body };
        }
        return send(200, 'application/json', JSON.stringify({ ...ctxCache.body, contradictions: readCheck() }));
      }
      // Contraddizioni tra le regole: le legge un agente (giudizio, non regex), su richiesta; il risultato resta in cache.
      if (req.url === '/api/contesto/check' && req.method === 'POST') {
        const cur = readCheck();
        if (cur.running && Date.now() - cur.startedAt < 20 * 60000) return send(200, 'application/json', JSON.stringify({ ok: true, already: true }));
        if (deps.noQueue || deps.inProcess) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'in demo il controllo non parte' }));
        let files = []; try { files = ((ctxCache && ctxCache.body) || await (await import('./context.mjs')).contextReport()).files.filter((f) => !f.generatedFrom && !String(f.path).includes('›')).map((f) => f.path); } catch { /* sotto */ }
        if (!files.length) return send(500, 'application/json', JSON.stringify({ error: 'nessun file da leggere' }));
        startCheck(files);
        return send(200, 'application/json', JSON.stringify({ ok: true }));
      }
      if (req.url === '/api/services') {
        if (deps.demoServices) return send(200, 'application/json', JSON.stringify(deps.demoServices()));
        if (!svcCache || Date.now() - svcCache.at > 60000) svcCache = await servicesSnapshot();
        return send(200, 'application/json', JSON.stringify(svcCache));
      }
      if (req.url === '/api/mac') return send(200, 'application/json', JSON.stringify(deps.demoMac ? deps.demoMac() : await macWatch.snapshot()));
      // Per la tray: il PC di casa dorme, e' acceso o lavora, e se il Mac e' carico mentre il PC dorme.
      // pc-state non sveglia il PC e non lo tiene sveglio; senza risposta in 10 s il PC e' "sconosciuto".
      if (deps.demo && (req.url === '/api/pc' || req.url === '/api/machines' || req.url.startsWith('/api/mac/trust'))) return send(200, 'application/json', JSON.stringify(req.url === '/api/machines' ? [] : { demo: true, items: [] }));
      if (req.url === '/api/pc') return send(200, 'application/json', JSON.stringify(await pcState()));
      // Le macchine in un elenco uniforme (questo Mac, il PC, domani altre): la tray disegna per ognuna la stessa card.
      // I nomi vengono dai dati: il nome di questo Mac da macOS, quello del PC da config.pcName.
      if (req.url === '/api/machines') {
        const [mac, pc] = await Promise.all([macWatch.snapshot().catch(() => null), pcState()]);
        return send(200, 'application/json', JSON.stringify([macMachine(mac, { name: computerName() }), pcMachine(pc, { name: config.pcName || 'PC', jobs: offloadJobs() })].filter(Boolean)));
      }
      // per gli agenti: chi è sospetto e perché (?all=1 anche gli ok). Mai vecchio di 2 minuti; al primo giro si legge adesso.
      if (req.url.startsWith('/api/mac/trust')) { if (!trust.last.at) await trust.scan(); return send(200, 'application/json', JSON.stringify(trust.report({ all: /[?&]all=1/.test(req.url) }))); }
      if (req.url === '/api/projects') return send(200, 'application/json', JSON.stringify(await report()));
      // Quote per account (tray, dashboard, script): calcolate qui; un errore non spegne la dashboard.
      if (req.url === '/api/overview') {
        try {
          const r = await hubFetch(`${(config.tray && config.tray.url) || 'http://127.0.0.1:3360'}/api/overview`, { signal: AbortSignal.timeout(20000) });
          return send(200, 'application/json', await r.text());
        } catch (err) { return send(200, 'application/json', JSON.stringify({ ok: false, error: err.message })); }
      }
      // Budget e azioni per VDM e quota-guard: sola lettura, il blocco lo applica `policy` (non il server).
      if (req.url === '/api/policy') {
        const policies = config.policies || defaultPolicies(loadBudgets(), loadMuseBudget());
        return send(200, 'application/json', JSON.stringify({ policies, firing: evaluatePolicies(await report(), policies) }));
      }
      // Previsione per abbonamento (fino a quando regge, buchi prima del reset) e frase per la cima del menu.
      if (req.url === '/api/forecast') {
        const fc = forecast(await paceRows());
        return send(200, 'application/json', JSON.stringify({ at: Date.now(), headline: headline(fc), providers: fc }));
      }
      // Azioni dal menu: override a tempo del freno di ritmo ({provider, hours, reason}) e stop dei lavori nuovi in background
      // ({hours, reason}). DELETE li toglie. Stesso registro e stesse regole del comando `usage-hub allow`.
      if (req.url.startsWith('/api/override') || req.url.startsWith('/api/hold')) {
        const hold = req.url.startsWith('/api/hold');
        if (req.method === 'POST') {
          const b = await readJson();
          const o = hold ? addHold({ hours: Number(b.hours) || 1, by: b.by || 'tray', reason: b.reason || 'Mac sotto sforzo' })
            : addOverride({ provider: b.provider, hours: Number(b.hours) || 2, by: b.by || 'tray', reason: b.reason || 'sbloccato dal menu' });
          return send(200, 'application/json', JSON.stringify(o));
        }
        if (req.method === 'DELETE') {
          const n = hold ? revokeHold() : revokeOverride(new URL(req.url, 'http://x').searchParams.get('provider'));
          return send(200, 'application/json', JSON.stringify({ removed: n }));
        }
        return send(200, 'application/json', JSON.stringify(activeOverrides(loadOverrides()).filter((o) => !!o.hold === hold)));
      }
      // Ritmo e gate: /api/pace, /api/gate?class=batch&skip=free
      if (req.url === '/api/pace' || req.url.startsWith('/api/gate') || req.url.startsWith('/api/route')) {
        const rows = await paceRows();
        if (req.url === '/api/pace') return send(200, 'application/json', JSON.stringify(rows));
        // Delega: /api/route?task=...&project=nome[&class=taste|mechanical|verify][&writer=muse|claude:opus…] → chi esegue.
        if (req.url.startsWith('/api/route')) {
          const q = new URL(req.url, 'http://x').searchParams;
          const project = q.get('project') || '';
          const projectInfo = (live.projects || []).find((p) => p.name === project) || null;
          const r = await route(rows, q.get('task') || '', { project, projectInfo, cls: q.get('class'), writer: q.get('writer') || '', overrides: activeOverrides(loadOverrides()), ...(deps.classify ? { classify: deps.classify } : {}) });
          return send(200, 'application/json', JSON.stringify(r));
        }
        // Per la tray: la decisione di ogni classe e il freno davanti a museagent e codexagent (classe batch).
        if (req.url === '/api/gates') {
          const ov = activeOverrides(loadOverrides());
          const classes = Object.fromEntries(Object.keys(CLASSES).map((c) => [c, { order: CLASSES[c], ...gate(rows, c, { overrides: ov }) }]));
          const brakes = Object.fromEntries(['muse', 'codex'].map((p) => [p, gate(rows, 'batch', { provider: p, overrides: ov })]));
          return send(200, 'application/json', JSON.stringify({ classes, brakes, providers: providerStates(rows, { overrides: ov }), overrides: ov, reserve: 10 }));
        }
        const q = new URL(req.url, 'http://x').searchParams;
        // project=nome: priorità e budget del progetto scelti in tray (le automazioni a orario chiedono così, cron-route).
        const project = (live.projects || []).find((p) => p.name === q.get('project')) || null;
        const g = gate(rows, q.get('class') || 'batch', { project, skip: (q.get('skip') || '').split(',').filter(Boolean), reserve: Number(q.get('reserve') || 10), overrides: activeOverrides(loadOverrides()) });
        return send(200, 'application/json', JSON.stringify(g));
      }
      if (req.url === '/api/alerts') {
        const r = await report();
        return send(200, 'application/json', JSON.stringify({ rules: config.alerts.rules || [], firing: evaluateRules(r, config.alerts.rules) }));
      }
      // Il proxy VDM (account, impostazioni, sessioni) resta il motore; la sua pagina non c'è più: la dashboard è questa.
      // in demo il proxy vero (account veri) non si legge: risponde quello finto, solo in lettura
      if (req.url.startsWith('/vdm/') && deps.demo) {
        if (req.method !== 'GET') return send(403, 'application/json', JSON.stringify({ error: 'in demo il proxy VDM non si modifica' }));
        const v = demoVdm(req.url);
        return v ? send(200, 'application/json', JSON.stringify(v)) : send(404, 'application/json', JSON.stringify({ error: 'non nella demo' }));
      }
      if (req.url.startsWith('/vdm/')) {
        // nella barra isolata (HUB_TEST_SANDBOX=1) il proxy vero non si raggiunge mai, nemmeno con la porta scritta in config
        const vdmPort = (config.vdm && config.vdm.port) || Number(process.env.USAGE_HUB_VDM_PORT) || 3335;
        if (process.env.HUB_TEST_SANDBOX === '1' && vdmPort === 3335) return send(500, 'application/json', JSON.stringify({ error: 'in prova il proxy VDM vero non si tocca' }));
        const up = http.request({ host: '127.0.0.1', port: vdmPort, path: req.url.slice(4), method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' } }, (r) => {
          res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json', 'cache-control': 'no-cache' });
          r.pipe(res);
          res.on('close', () => r.destroy());
        });
        up.on('error', (e) => { if (!res.headersSent) send(502, 'application/json', JSON.stringify({ error: 'proxy VDM non raggiungibile: ' + e.message })); else res.end(); });
        return req.pipe(up);
      }
      const pathname = req.url.split('?')[0];
      if (pathname === '/' || pathname === '/index.html') {
        return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
      }
      const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
      const ext = path.extname(pathname);
      if (STATIC[ext] && /^\/[\w.-]+(\/[\w.-]+)?$/.test(pathname) && !pathname.includes('..')) {
        const file = path.join(ROOT, 'public', pathname);
        if (fs.existsSync(file)) return send(200, STATIC[ext], fs.readFileSync(file));
      }
      send(404, 'text/plain', 'not found');
    } catch (err) {
      send(502, 'application/json', JSON.stringify({ error: err.message }));
    }
  });
}
