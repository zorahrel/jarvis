// Copiato da ~/.openclaw/bin/cron-health.mjs il 23/10.
// readFacts riceve accettati e correzioni come parametri invece di leggerli da file.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const DAY = 86400e3;
const oc = (args) => JSON.parse(execFileSync('openclaw', args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 120e3 }));

// Riassunti che dicono «non ho fatto niente»: un turno LLM pagato per scoprirlo.
export const IDLE_RUN = /\b(rimand|saltat|salto|niente da fare|nessuna novit|non (è|e') inattiv|condizione non|attivo da|termino subito|NO_REPLY)\b/i;
const QUOTA_WORDS = /\b(codex|muse|gemini)\b/i; // il nome del provider, non «esaurito» (lotto4: «lotto 3 esaurito»)

// Il punto critico: dai fatti alle righe. facts = { now, jobs, runsByJob, delivered, doctor, scratchLen }
export function findings(f) {
  const out = [];
  const name = (j) => `${j.name} (${j.id.slice(0, 8)})`;
  for (const j of f.jobs) {
    if (!j.enabled) continue;
    const runs = (f.runsByJob[j.id] || []).filter((r) => f.now - (r.runAtMs || r.ts || 0) < 7 * DAY);
    const errs = runs.filter((r) => r.status === 'error');
    const recentErrs = errs.filter((r) => f.now - (r.runAtMs || r.ts) < DAY);
    // Errori già chiusi non sono «cosa non va» (23/10: cron-route, 3 errori alle 2 poi 70 giri ok): restano se
    // l'ultimo giro è ancora in errore o se sono almeno un quinto dei giri del giorno (un job che va e viene).
    const day = runs.filter((r) => f.now - (r.runAtMs || r.ts) < DAY);
    const latest = day.reduce((a, r) => ((r.runAtMs || r.ts) > (a?.runAtMs || a?.ts || 0) ? r : a), null);
    if (recentErrs.length >= 2 && (latest?.status === 'error' || recentErrs.length >= day.length / 5)) out.push({ kind: 'errori', line: `${name(j)}: ${recentErrs.length} errori nelle ultime 24h, l'ultimo: ${(recentErrs[0].error || '').slice(0, 140)}` });
    const llm = j.payload?.kind === 'agentTurn';
    if (llm && j.schedule?.kind !== 'at' && !j.trigger) {
      const last = runs.filter((r) => r.status === 'ok').slice(0, 8);
      if (last.length >= 5 && last.every((r) => IDLE_RUN.test(r.summary || ''))) {
        out.push({ kind: 'a vuoto', line: `${name(j)}: ${last.length} turni LLM di fila senza lavoro («${(last[0].summary || '').replace(/\s+/g, ' ').slice(0, 80)}»): la condizione va in un trigger (cron-when), non nel prompt` });
      }
    }
    if (llm && j.schedule?.kind === 'at' && !j.trigger && QUOTA_WORDS.test(j.payload?.message || '')) {
      const when = new Date(Date.parse(j.schedule.at)).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      out.push({ kind: 'attesa fissa', line: `${name(j)}: aspetta una quota fino al ${when} a ora fissa: un altro provider libero fa lo stesso lavoro? Altrimenti cron-when arm ${j.id.slice(0, 8)} --free any` });
    }
    // Rumore che è già finito (quota-guard: 14 messaggi il 16-18/10, poi zero dopo la correzione) non è rumore adesso.
    // «consegna spesso» prima del numero: un silenzio («health:<nome> (<id>): consegna spesso») vale a ogni conteggio
    // senza coprire gli errori dello stesso job (24/10: mailwatch, avvisare è il suo mestiere).
    const sent = f.delivered[j.id] || 0, lastSent = f.lastDelivered?.[j.id];
    if (sent > 10 && !(f.now - lastSent > 2 * DAY)) out.push({ kind: 'rumore', line: `${name(j)}: consegna spesso, ${sent} messaggi in 7 giorni` });
    // 24/10: aws-case-check avvisava su WhatsApp senza destinatario, ogni giro finiva in errore e l'avviso non sarebbe
    // mai arrivato. Un cron «at» fallisce una volta sola e la regola degli errori (2 in 24h) non lo vede: qui si guarda
    // la configurazione. «last» non vuole destinatario.
    const d = j.delivery;
    if (d?.mode === 'announce' && d.channel && d.channel !== 'last' && !d.to) out.push({ kind: 'senza destinatario', line: `${name(j)}: avvisa su ${d.channel} senza destinatario, l'avviso non arriva: openclaw cron edit ${j.id} --to …` });
  }
  if (f.scratchLen > 4000) out.push({ kind: 'heartbeat', line: `scratch dell'heartbeat a ${Math.round(f.scratchLen / 1000)} KB: con compiti chiusi dentro il modello gira sempre; vuoto = nessun turno` });
  for (const d of f.doctor || []) out.push({ kind: 'doctor', line: `doctor ${d.severity}: ${d.checkId} — ${(d.message || '').slice(0, 140)}` });
  // Accettati: righe che Attilio (o una regola scritta) ha già deciso di tenere; ognuno porta il suo perché.
  return out.filter((o) => !(f.accepted || []).some((a) => o.line.includes(a.match)));
}

// Correzioni: [{job, at, why}]. Di quel job si giudica solo ciò che è successo dopo «at», così una correzione
// fatta oggi non resta in «Cosa non va» per i 7 giorni della finestra (23/10: usage-hub, 31 messaggi di prima).
export function readFacts({ accepted = [], fixes = [] } = {}) {
  const now = Date.now();
  const after = (id, r) => fixes.every((x) => !String(id || '').startsWith(x.job) || (r.runAtMs || r.ts || 0) >= Date.parse(x.at));
  const jobs = oc(['cron', 'list', '--all', '--json']).jobs || [];
  const runsByJob = {};
  // Storia per job: solo quelli LLM ricorrenti e gli errori di tutti (mailwatch da solo fa 10mila giri a settimana).
  for (const j of jobs.filter((x) => x.enabled && x.payload?.kind === 'agentTurn' && x.schedule?.kind !== 'at')) {
    runsByJob[j.id] = oc(['cron', 'runs', '--id', j.id, '--limit', '10', '--sort', 'desc']).entries || [];
  }
  for (const r of oc(['cron', 'runs', '--all', '--status', 'error', '--limit', '200', '--sort', 'desc']).entries || []) {
    const id = r.jobId || r.id;
    if (!runsByJob[id]?.some((x) => x.runId && x.runId === r.runId)) (runsByJob[id] ||= []).push(r);
  }
  // Chi ha almeno 2 errori nelle 24h: tutta la giornata, per sapere se l'errore è ancora aperto (findings).
  for (const [id, rs] of Object.entries(runsByJob)) {
    if (rs.filter((r) => r.status === 'error' && now - (r.runAtMs || r.ts || 0) < DAY).length < 2) continue;
    const seen = new Set(rs.map((r) => r.runId || r.ts));
    for (const r of oc(['cron', 'runs', '--id', id, '--limit', '200', '--sort', 'desc']).entries || []) if (!seen.has(r.runId || r.ts)) rs.push(r);
  }
  // L'API dà al massimo 200 righe: si pagina finché si esce dalla settimana.
  const delivered = {}, lastDelivered = {};
  for (let offset = 0; offset < 4000; offset += 200) {
    const page = oc(['cron', 'runs', '--all', '--delivery-status', 'delivered', '--limit', '200', '--offset', String(offset), '--sort', 'desc']).entries || [];
    const week = page.filter((r) => now - (r.runAtMs || r.ts || 0) < 7 * DAY);
    for (const r of week.filter((x) => after(x.jobId, x))) {
      delivered[r.jobId] = (delivered[r.jobId] || 0) + 1;
      lastDelivered[r.jobId] = Math.max(lastDelivered[r.jobId] || 0, r.runAtMs || r.ts || 0);
    }
    if (page.length < 200 || week.length < page.length) break;
  }
  for (const id of Object.keys(runsByJob)) runsByJob[id] = runsByJob[id].filter((r) => after(id, r));
  // --allow-exec: con il token del gateway nel Keychain (SecretRef exec, 22/10) senza questo flag il doctor
  // salta il controllo di salute del gateway e lo segnala come avviso nuovo.
  let doctor = [];
  // Tetto 7 minuti: col Mac carico il doctor ne prende più di 4 (261 s il 24/10) e a 180 s l'output tagliato a metà
  // diventava «doctor non leggibile», un rosso falso. Il cron ha 10 minuti in tutto. Lento non è rotto: avviso, non errore.
  try { execFileSync('openclaw', ['doctor', '--lint', '--json', '--allow-exec'], { encoding: 'utf8', timeout: 420e3, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) {
    try { doctor = JSON.parse(String(e.stdout).slice(String(e.stdout).indexOf('{'))).findings || []; }
    catch { doctor = [e.signal || e.code === 'ETIMEDOUT' ? { severity: 'warning', checkId: 'doctor', message: 'non ha finito in 7 minuti (Mac carico): esito del doctor non disponibile' } : { severity: 'error', checkId: 'doctor', message: 'non leggibile' }]; }
  }
  const hb = jobs.find((j) => /^heartbeat:/.test(j.declaration || j.declarationKey || '') || /^Heartbeat/.test(j.name));
  let scratchLen = 0;
  if (hb) { try { scratchLen = execFileSync('openclaw', ['cron', 'scratch', hb.id], { encoding: 'utf8' }).length; } catch { /* senza scratch l'heartbeat decide da solo */ } }
  return { now, jobs, runsByJob, delivered, lastDelivered, doctor, scratchLen, accepted };
}
