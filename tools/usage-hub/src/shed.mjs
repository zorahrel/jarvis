// Pausa degli agenti in background quando il Mac è sotto sforzo, ripresa quando respira.
//
// Cosa NON si ferma mai: le sessioni interattive (davanti a una persona), i lavori di priorità alta, chiunque non sia un agente
// non interattivo riconosciuto. Per loro il Mac può solo avvisare.
// Cosa si ferma: un solo agente per volta (Topics fa lo stesso: una azione ogni 120 s), nell'ordine batch → massivo → resto, prima i
// progetti a priorità bassa. La pausa è un SIGSTOP all'albero di processi e dura al massimo 2 minuti: la prova dal vivo (18/10, claude -p
// fermato per 30 s e per 150 s a metà risposta) ha visto la sessione finire senza errori; oltre non è provato, quindi non si va oltre.
// Topics (server/services/swap-freeze.ts) ha gli stessi limiti per lo stesso motivo: massimo 2 pause per albero, mai più di 10 minuti.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SHED = { maxPauseMs: 120000, minPauseMs: 60000, spacingMs: 120000, maxPaused: 2, perAgentMax: 2 };
// Quanto deve pesare un agente perché fermarlo serva. Il 23/10 (23:32-00:00) il freno ha fermato 13 volte agenti quasi fermi
// mentre a pesare erano un server TypeScript da 3 GB e il gateway OpenClaw: il Mac è rimasto carico e il lavoro è andato più piano.
// CPU: un core intero dell'albero (ps pcpu, media dell'ultimo minuto) è ~1/18 della soglia di 1,5 per core su 12 core.
// Memoria: SIGSTOP non libera RAM, toglie solo chi la sta toccando; quindi albero ≥ 1,5 GB e ancora al lavoro (≥ ¼ di core).
export const WEIGHT = { cpuCores: 1, memMB: 1536, memCpuCores: 0.25 };
export function weighs(c, st = { byLoad: true, byMem: true }, w = WEIGHT) {
  if (c.kind === 'sonda') return true; // la sonda di prova esiste per essere fermata
  const cpu = c.cpu || 0, mem = c.memMB || 0;
  return (st.byLoad !== false && cpu >= w.cpuCores) || (st.byMem !== false && mem >= w.memMB && cpu >= w.memCpuCores);
}
const ELIGIBLE = new Set(['sonda', 'sottoagente', 'codex-exec', 'muse-job', 'claude-job']);
const PRIO = { bassa: 0, normale: 1 };
const CLS = { batch: 0, massivo: 1 };

// Il punto critico: chi può essere messo in pausa. Interattivi e priorità alta mai.
export function eligible(c) {
  if (!c || !ELIGIBLE.has(c.kind)) return false;
  if (c.priority === 'alta') return false;
  return true;
}

// Ordine di pausa: priorità bassa prima, poi batch, massivo, il resto; a parità il più pesante.
export function rank(candidates) {
  return candidates.filter(eligible).sort((a, b) =>
    (c0(a) - c0(b)) || ((PRIO[a.priority] ?? 1) - (PRIO[b.priority] ?? 1)) || ((CLS[a.cls] ?? 2) - (CLS[b.cls] ?? 2)) || ((b.memMB || 0) - (a.memMB || 0)));
}
const c0 = (c) => (c.kind === 'sonda' ? 0 : 1); // la sonda di prova va sempre per prima

const fmt1 = (x) => x.toFixed(1).replace('.', ',');

export function createShed({ probe, signal = (pid, sig) => process.kill(pid, sig), file = path.join(os.homedir(), '.cache', 'claude-usage-hub', 'paused.json'), now = Date.now, log = () => {}, notify = () => {}, onEvent = () => {}, limits = SHED, enabled = true } = {}) {
  let ledger = [];
  const counts = new Map(); // pid → pause in questo episodio di sforzo
  let lastActionAt = 0;
  let status = { strained: false, reason: '', note: '' };
  try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')).paused || []; } catch { ledger = []; }
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ paused: ledger })); } catch { /* il registro è un di più: senza, la ripresa all'avvio non sa chi riprendere */ } };
  const sig = (pid, s) => { try { signal(pid, s); return true; } catch { return false; } };

  async function thaw(entry, why) {
    for (const pid of [...entry.pids].reverse()) sig(pid, 'SIGCONT');
    ledger = ledger.filter((e) => e !== entry); save();
    const text = `ripreso: ${entry.label} (${why})`;
    log(text); notify(text); onEvent({ type: 'resume', at: now(), label: entry.label });
    return text;
  }

  return {
    get paused() { return ledger; },
    get status() { return status; },
    // Ripresa di tutto, per l'avvio e per lo spegnimento: un processo fermo per sempre sarebbe peggio del carico.
    async thawAll(why = 'riavvio del hub') {
      for (const e of [...ledger]) {
        const start = e.start && (await probe.startTime(e.pid));
        if (!start || start === e.start) await thaw(e, why); else { ledger = ledger.filter((x) => x !== e); save(); } // '' = ps non ha risposto: si riprende
      }
    },
    async tick() {
      const t = now(), mac = await probe.mac(), verdict = probe.verdict(), st = probe.strain(mac, verdict);
      status = { ...st, note: '' };
      // 1. riprese: processo sparito, tempo massimo, oppure il Mac respira (dopo almeno un minuto, per non rimbalzare)
      const table = await probe.table();
      // ps in timeout (succede proprio col Mac sotto sforzo) dà una tabella vuota: se valesse come «tutti spariti», chi è in pausa
      // uscirebbe dal registro senza SIGCONT e resterebbe fermo per sempre (22/10, un sottoagente di OpenClaw fermo 14 minuti).
      if (!table.length) return status;
      for (const e of [...ledger]) {
        const alive = table.some((r) => r.pid === e.pid);
        if (!alive) { ledger = ledger.filter((x) => x !== e); save(); continue; }
        const start = e.start && (await probe.startTime(e.pid));
        if (start && start !== e.start) { ledger = ledger.filter((x) => x !== e); save(); continue; } // pid riusato: non è più il nostro
        if (t - e.since >= limits.maxPauseMs) await thaw(e, `dopo ${Math.round(limits.maxPauseMs / 60000)} minuti, il limite`);
        else if (st.calm && t - e.since >= limits.minPauseMs) await thaw(e, `Mac a ${fmt1(mac.loadPerCore)} per core, sotto ${fmt1(probe.maxLoad)}`);
      }
      if (!st.strained) { counts.clear(); return status; }
      if (!enabled) { status.note = 'pausa degli agenti spenta'; return status; }
      if (ledger.length >= limits.maxPaused || t - lastActionAt < limits.spacingMs) return status;
      // 2. una pausa, la prima della lista
      const cands = (await probe.candidates(table)).filter((c) => (counts.get(c.pid) || 0) < limits.perAgentMax && !ledger.some((e) => e.pid === c.pid));
      const pick = rank(cands.filter((c) => weighs(c, st)))[0];
      if (!pick) {
        status.note = rank(cands).length ? 'gli agenti in background pesano poco: fermarli non alleggerisce il Mac (solo avviso)'
          : 'nessun agente in background da fermare: restano solo sessioni aperte o lavori di priorità alta (solo avviso)';
        return status;
      }
      const start = await probe.startTime(pick.pid);
      if (!start) return status; // senza identità non si manda nessun segnale
      const pids = probe.tree(table, pick.pid);
      for (const pid of pids) sig(pid, 'SIGSTOP');
      counts.set(pick.pid, (counts.get(pick.pid) || 0) + 1);
      lastActionAt = t;
      const label = `${pick.project || 'senza progetto'} · ${pick.kind}${pick.model ? ' ' + pick.model : ''}`;
      const entry = { pid: pick.pid, pids, start, since: t, project: pick.project || '', kind: pick.kind, label, reason: `in pausa: ${st.reason}, riprende sotto ${fmt1(probe.maxLoad)} per core o dopo ${Math.round(limits.maxPauseMs / 60000)} min` };
      ledger.push(entry); save();
      log(entry.reason + ' — ' + label); notify(`${entry.reason} (${label})`);
      onEvent({ type: 'pause', at: t, label, reason: st.reason });
      return status;
    },
  };
}

// Un riepilogo per episodio di sforzo (Attilio 19/10: «va capito»; 24/10: «capire cosa sta bloccando direttamente e perché,
// e metterlo in cima»). L'episodio va dal primo giro sotto sforzo all'ultimo e si chiude dopo `quietMs` di Mac tranquillo.
// Prima riga: chi bloccava, misurato al picco dell'episodio (non quando si scrive), e perché pesa. Seconda: cosa ho fatto
// o cosa serve da lui. Su WhatsApp solo se c'è una delle due; un episodio che si sistema da solo resta nel log e in `recent`.
const hhmm = (ms) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const gb = (mb) => `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const span = (ms) => (ms >= 2 * DAY ? `${Math.round(ms / DAY)} giorni` : ms >= 2 * HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.max(1, Math.round(ms / MIN))} min`);
export const DIGEST = { quietMs: 10 * MIN, minStrainMs: 10 * MIN, sampleMs: 2 * MIN, calmSampleMs: 10 * MIN, gatewayMaxMB: 4096, gatewayAfterMs: 5 * MIN, restartEveryMs: 6 * HOUR, adviceMinMB: 2048, adviceEveryMs: DAY, growMB: 1024 };
// Cosa può fare lui, per tipo di processo; il gateway OpenClaw non è qui perché lo riavvio io.
const ADVICE = { tsserver: 'riavvia quella sessione, se non ti serve più', mcp: 'va riavviato dal gateway MCP (chiedimelo)', app: 'chiudila se non ti serve', sessione: 'chiudi la sessione se non ti serve', altro: 'chiudilo se non ti serve' };

export function createShedDigest({ send = () => {}, log = () => {}, hogs = async () => [], offloads = async () => [], restartGateway = null, now = Date.now, limits = DIGEST } = {}) {
  let ep = null;
  let lastRestartAt = -Infinity, lastCalmSample = -Infinity;
  const advised = new Map(); // nome → quando gliel'ho detto: lo stesso consiglio una volta al giorno
  const seen = new Map();    // nome → campioni {at, memMB} delle ultime 24 h: dicono se un processo è cresciuto
  const recent = [];
  const open = (at) => (ep = ep || { from: at, to: at, pauses: 0, agents: new Set(), open: 0, peak: new Map(), actions: [], causes: new Set(), lastSample: -Infinity });
  const remember = (hs, at) => {
    for (const h of hs) { const l = seen.get(h.name) || []; l.push({ at, memMB: h.memMB }); seen.set(h.name, l.filter((x) => at - x.at < DAY)); }
  };
  // Perché pesa: è cresciuto (≥ 1 GB da almeno mezz'ora), macina CPU, è appeso a una sessione vecchia, o è acceso da giorni.
  const why = (h, at) => {
    const first = (seen.get(h.name) || [])[0];
    if (first && at - first.at >= 30 * MIN && h.memMB - first.memMB >= limits.growMB) return `cresciuto da ${gb(first.memMB)} in ${span(at - first.at)}`;
    if (h.cpu >= 1) return `CPU al ${Math.round(h.cpu * 100)}%`;
    if (h.owner) return h.owner;
    if (h.ageS >= 86400) return `acceso da ${span(h.ageS * 1000)}`;
    return '';
  };

  return {
    get recent() { return recent; },
    // Ogni giro del freno: tiene aperto l'episodio, misura chi pesa ogni 2 minuti, e se è il gateway oltre 4 GB lo riavvia.
    // A Mac tranquillo un campione ogni 10 minuti, perché «cresciuto da 1,5 GB in 5 h» ha bisogno del prima.
    async tick(st, at = now()) {
      if (!st || !st.strained) {
        if (at - lastCalmSample >= limits.calmSampleMs) { lastCalmSample = at; remember(await hogs().catch(() => []), at); }
        return;
      }
      const e = open(at); e.to = at;
      if (st.byLoad) e.causes.add('processore al limite');
      if (st.byMem) e.causes.add('memoria piena');
      if (at - e.lastSample < limits.sampleMs) return;
      e.lastSample = at;
      const hs = await hogs().catch(() => []);
      for (const h of hs) if (!(e.peak.get(h.name)?.memMB >= h.memMB)) e.peak.set(h.name, { ...h, why: why(h, at) });
      remember(hs, at);
      const gw = hs.find((h) => h.kind === 'gateway');
      if (gw && gw.memMB >= limits.gatewayMaxMB && at - e.from >= limits.gatewayAfterMs && at - lastRestartAt >= limits.restartEveryMs && restartGateway) {
        lastRestartAt = at;
        const ok = await Promise.resolve(restartGateway()).then((r) => r !== false, () => false);
        e.actions.push({ name: gw.name, text: ok ? 'gateway OpenClaw: riavvio sicuro chiesto, parte a lavori finiti' : 'gateway OpenClaw: il riavvio non è partito, guardalo tu' });
        log(`gateway OpenClaw a ${gb(gw.memMB)}: ${ok ? 'riavvio sicuro chiesto' : 'riavvio non partito'}`);
      }
    },
    event(e) {
      if (e.type === 'pause') { const x = open(e.at); x.to = Math.max(x.to, e.at); x.pauses++; x.open++; x.agents.add(e.label); }
      else if (e.type === 'resume' && ep) ep.open = Math.max(0, ep.open - 1);
    },
    async flush(at = now()) {
      if (!ep || at - ep.to < limits.quietMs) return null;
      const e = ep; ep = null;
      if (e.to - e.from < limits.minStrainMs && !e.actions.length) return null; // un picco breve non è un episodio
      const top = [...e.peak.values()].sort((a, b) => b.memMB - a.memMB);
      const [h0, h1] = top;
      const blocker = h0 ? `${h0.name} ${gb(h0.memMB)}${h0.why ? ` (${h0.why})` : ''}${h1 && h1.memMB >= limits.adviceMinMB ? `, poi ${h1.name} ${gb(h1.memMB)}${h1.why ? ` (${h1.why})` : ''}` : ''}` : '';
      // consiglio solo sul primo, se è grosso, non l'ho già sistemato io e non gliel'ho già detto oggi
      const fixed = new Set(e.actions.map((a) => a.name));
      let advice = '';
      if (h0 && ADVICE[h0.kind] && !fixed.has(h0.name) && h0.memMB >= limits.adviceMinMB && !(at - (advised.get(h0.name) ?? -Infinity) < limits.adviceEveryMs)) {
        advice = ADVICE[h0.kind]; advised.set(h0.name, at);
      }
      const n = e.agents.size;
      const moved = (await offloads(e.from, at).catch(() => [])).length;
      const extra = [
        n ? `${n === 1 ? '1 lavoro' : `${n} lavori`} in pausa breve${e.open ? `, ${e.open} ancora ferm${e.open === 1 ? 'o' : 'i'}` : ''}` : '',
        moved ? `${moved === 1 ? '1 lavoro pesante spostato' : `${moved} lavori pesanti spostati`} sul PC` : '',
      ].filter(Boolean).join(', ');
      const did = [...e.actions.map((a) => a.text), advice].filter(Boolean).join('; ');
      const text = [
        `🔴 Mac bloccato ${hhmm(e.from)}–${hhmm(e.to)}${blocker ? ` da ${blocker}` : ` (${[...e.causes].join(' e ') || 'carico alto'})`}.`,
        [did ? `→ ${did}` : '', extra].filter(Boolean).join('. ') + (did || extra ? '.' : ''),
      ].filter((l) => l && l !== '.').join('\n');
      const push = Boolean(did);
      recent.unshift({ at, from: e.from, to: e.to, text, push }); recent.length = Math.min(recent.length, 10);
      if (push) send(text); else log(text.replace('\n', ' '));
      return { text, push };
    },
  };
}
