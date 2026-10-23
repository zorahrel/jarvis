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
      const pick = rank(cands)[0];
      if (!pick) { status.note = 'nessun agente in background da fermare: restano solo sessioni aperte o lavori di priorità alta (solo avviso)'; return status; }
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

// Su WhatsApp un riassunto per episodio, non una riga per pausa (Attilio 19/10: «va capito»).
// Un episodio si chiude dopo `quietMs` senza pause nuove; sotto `minPauses` non vale un messaggio.
const hhmm = (ms) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const who = (label) => (label.startsWith('openclaw/') ? 'i sottoagenti di OpenClaw' : `i lavori di ${label.split(' · ')[0]}`);
export function createShedDigest({ send, hogs = async () => [], now = Date.now, quietMs = 10 * 60000, minPauses = 3 } = {}) {
  let ep = null; // { from, to, pauses, causes:Set, whos:Set, open }
  return {
    event(e) {
      if (e.type === 'pause') {
        ep = ep || { from: e.at, pauses: 0, causes: new Set(), whos: new Set(), open: 0 };
        ep.to = e.at; ep.pauses++; ep.open++; ep.whos.add(who(e.label));
        if (/memoria/.test(e.reason || '')) ep.causes.add('memoria piena');
        if (/per core/.test(e.reason || '')) ep.causes.add('processore al limite');
      } else if (e.type === 'resume' && ep) ep.open = Math.max(0, ep.open - 1);
    },
    async flush() {
      if (!ep || now() - ep.to < quietMs) return null;
      const e = ep; ep = null;
      if (e.pauses < minPauses) return null;
      const top = (await hogs().catch(() => [])).slice(0, 2)
        .map((h) => `${h.name} ${(h.memMB / 1024).toFixed(1).replace('.', ',')} GB`);
      const text = [
        `Mac sotto sforzo dalle ${hhmm(e.from)} alle ${hhmm(e.to)} (${[...e.causes].join(' e ') || 'carico alto'}).`,
        `Ho messo in pausa ${e.pauses} volte ${[...e.whos].join(' e ')}, al massimo 2 minuti ogni volta: il lavoro va più piano, non si perde niente.`,
        top.length ? `Pesano di più adesso: ${top.join(', ')}.` : '',
        e.open ? `Ancora in pausa: ${e.open}, ripartono da soli.` : 'Ora è tutto ripartito.',
      ].filter(Boolean).join('\n');
      send(text);
      return text;
    },
  };
}
