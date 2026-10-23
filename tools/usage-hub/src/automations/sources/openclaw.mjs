// Fonte OpenClaw: legge cron_jobs e cron_run_receipts dal sqlite, in sola lettura.
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { whenOf, condOf, whoOf, outOf, promptOf } from '../describe.mjs';

const DAY = 86400000;
const WEEK = 7 * DAY;

// Intervallo tipico da un'espressione cron a 5 campi.
function cronEveryMs(expr) {
  const [mi, h, dom, , dow] = String(expr || '').split(/\s+/);
  if (/^\d+$/.test(mi || '') && /^\d+$/.test(h || '')) {
    if (dom && dom !== '*') return 30 * DAY; // giorno del mese fisso
    if (!dow || dow === '*' || dow === '1-5') return DAY; // ogni giorno o lun-ven
    if (/^\d+$/.test(dow)) return WEEK; // un solo giorno della settimana
    return DAY; // lista o intervallo di giorni
  }
  if (/^\d+$/.test(mi || '') && (h === '*' || /^\*\/\d+$/.test(h || ''))) {
    return h === '*' ? 3600000 : Number(h.slice(2)) * 3600000;
  }
  return null;
}

const mapOutcome = (s) => (s === 'interrupted' ? 'error' : s);

export function readOpenclaw({ db = '~/.openclaw/state/openclaw.sqlite', now = Date.now(), uiBase = 'http://127.0.0.1:18789' } = {}) {
  const file = db.replace(/^~(?=\/|$)/, os.homedir());
  let sql;
  try {
    sql = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = sql.prepare('select job_id, name, enabled, payload_kind, job_json, state_json from cron_jobs').all();
      const weekAgo = now - 7 * DAY;
      const receipts = sql.prepare('select job_id, status, started_at_ms, finished_at_ms, error_text from cron_run_receipts where started_at_ms > ? order by started_at_ms desc').all(weekAgo);
      const byJob = new Map();
      for (const r of receipts) {
        if (!byJob.has(r.job_id)) byJob.set(r.job_id, []);
        byJob.get(r.job_id).push(r);
      }
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const midnightMs = midnight.getTime();
      let dated = 0, disabled = 0;
      const items = [];
      for (const row of rows) {
        if (!row.enabled) { disabled++; continue; }
        const job = { id: row.job_id, name: row.name, enabled: !!row.enabled, ...JSON.parse(row.job_json) };
        if (job.schedule?.kind === 'at') { dated++; continue; } // promemoria a data, non automazione
        const state = JSON.parse(row.state_json || '{}');
        const recs = byJob.get(row.job_id) || [];
        const cond = condOf(job);
        const when = whenOf(job.schedule) + (cond ? `, se ${cond}` : '');
        const every = job.schedule?.kind === 'every';
        const everyMs = every ? job.schedule.everyMs : job.schedule?.kind === 'cron' ? cronEveryMs(job.schedule.expr) : null;
        const lastReceiptAt = recs.length ? recs[0].started_at_ms : null;
        const lastAt = state.lastRunAtMs ?? lastReceiptAt ?? null;
        const rawStatus = state.lastRunStatus ?? state.lastStatus ?? null;
        const outcome = rawStatus == null ? null : mapOutcome(rawStatus);
        const lastError = state.lastError != null ? String(state.lastError).slice(0, 200) : null;
        const ran = lastAt != null || rawStatus != null || recs.length > 0;
        let delivered = null;
        if (ran) {
          const suppressed = state.deliverySuppressionReason || /suppress/i.test(state.lastDiagnosticSummary || '');
          if (state.lastDeliveryStatus === 'delivered') delivered = 'delivered';
          else if (state.lastDeliveryStatus === 'not-delivered' && !suppressed && job.delivery?.mode === 'announce') delivered = 'failed';
          else delivered = 'none';
        }
        const runs = recs.slice(0, 10).map((r) => ({ at: r.started_at_ms, outcome: mapOutcome(r.status) }));
        // Tutti i giri delle ultime 24 ore, per la striscia della tabella (i job al minuto ne hanno fino a 1440).
        const day = recs.filter((r) => r.started_at_ms > now - DAY).slice(0, 2000).map((r) => [r.started_at_ms, mapOutcome(r.status)]);
        let runsToday = recs.filter((r) => r.started_at_ms >= midnightMs).length;
        if (every && recs.length >= 60 && recs[recs.length - 1].started_at_ms >= midnightMs) {
          runsToday = Math.floor((now - midnightMs) / job.schedule.everyMs); // stima per i job frequenti
        }
        const w = whoOf(job);
        const exit = /exited with code (\d+)/.exec(lastError || '')?.[1];
        items.push({
          key: `cron:${row.job_id}`,
          provider: 'openclaw',
          name: job.name,
          enabled: true,
          everyMs,
          when,
          next: state.nextRunAtMs ?? null,
          nextApprox: false,
          expectedLast: null,
          last: { at: lastAt, outcome, delivered, error: lastError },
          runs,
          day,
          consecutiveErrors: state.consecutiveErrors ?? 0,
          runsToday,
          who: w.who,
          reportsTo: outOf(job),
          tech: {
            schedule: job.schedule?.expr || whenOf(job.schedule),
            exit: exit != null ? Number(exit) : null,
            command: job.payload?.kind === 'command' ? (w.cmd ?? null) : null,
            prompt: job.payload?.kind !== 'command' ? promptOf(job) : null,
            label: job.name,
            // Control UI: la build installata espone solo la rotta /automations (alias /cron),
            // senza parametro per il singolo job negli asset compilati.
            url: `${uiBase}/automations`,
          },
        });
      }
      return { ok: true, at: now, items, dated, disabled };
    } finally {
      sql.close();
    }
  } catch (e) {
    try { sql?.close(); } catch { /* già chiuso o mai aperto */ }
    return { ok: false, at: now, items: [], error: String(e?.message || e) };
  }
}
