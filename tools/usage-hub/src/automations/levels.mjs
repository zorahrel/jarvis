// Livelli te/rotto/va/nascosto: giudizio puro, niente io né orologio.
const H = 3600000;
const DAY = 24 * H;
const WEEK = 7 * DAY;

const fmt = (opts) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', ...opts });

function rome(at) {
  const p = {};
  for (const x of fmt({ weekday: 'long', day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(at))) p[x.type] = x.value;
  return p;
}

// «stanotte alle 4:32», «oggi alle 15:02», «ieri alle 9:30», «domenica alle 3:19», oltre la settimana «il 16/9 alle 8:47».
const dayTime = (at, now) => {
  const p = rome(at);
  const dayOf = (t) => fmt({ year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(t));
  const hm = `${p.hour}:${p.minute}`;
  if (now != null && dayOf(at) === dayOf(now)) return (Number(p.hour) < 6 ? 'stanotte' : 'oggi') + ' alle ' + hm;
  if (now != null && dayOf(at) === dayOf(now - DAY)) return 'ieri alle ' + hm;
  if (now != null && now - at > 6 * DAY) return `il ${p.day}/${p.month} alle ${hm}`;
  return `${p.weekday} alle ${hm}`;
};

// «16/9 alle 8:47».
const calWords = (at) => {
  const p = rome(at);
  return `${p.day}/${p.month} alle ${p.hour}:${p.minute}`;
};

// «12 minuti», «4 ore», «3 giorni».
function durWords(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m === 1 ? '1 minuto' : `${m} minuti`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? '1 ora' : `${h} ore`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 giorno' : `${d} giorni`;
}

const isErr = (r) => !!r && r.outcome === 'error';
const isOk = (r) => !!r && r.outcome === 'ok';

// Errori di fila da `from`, senza saltare: il primo giro diverso chiude la striscia.
function leadingErrors(runs, from = 0) {
  let n = 0;
  for (let i = from; i < runs.length; i++) {
    if (isErr(runs[i])) n++;
    else break;
  }
  return n;
}

// L'errore più vecchio della striscia, per `since`.
function oldestErrorAt(runs, from = 0) {
  let at = null;
  for (let i = from; i < runs.length; i++) {
    if (!isErr(runs[i])) break;
    if (runs[i].at != null) at = runs[i].at;
  }
  return at;
}

// Quanti errori di fila servono per dire rotto: 10 minuti di errori, minimo 2.
const needOf = (i) => Math.max(2, Math.ceil((10 * 60 * 1000) / i));

// Rotta da oltre 7 giorni senza che nessuno l'abbia guardata: serve Attilio.
function escalate(res, now, fb) {
  if (res.level !== 'rotto' || res.since == null || now - res.since <= WEEK) return res;
  const seen = (fb.history || []).some((r) => Date.parse(r.at) > res.since);
  if (seen) return res;
  return { level: 'te', reason: `rotta da ${durWords(now - res.since)} e nessuno l'ha guardata`, since: res.since };
}

// Quanto si aspetta oltre l'intervallo prima di dire «non gira»: due giri, almeno un'ora; GitHub ritarda da sé.
export function lateTolerance(I, provider) {
  if (provider === 'github') return 12 * H;
  return I != null && I > 0 ? Math.max(2 * I, H) : null;
}

export function levelOf(item, ctx = {}) {
  const { now, desc = null, fb = null, proof = null } = ctx;
  const f = fb || { vote: null, changedSinceVote: false, mute: null, open: [], notes: [], history: [] };
  const last = item.last || {};
  const runs = Array.isArray(item.runs) ? item.runs : [];
  const rotto = (reason, since) => escalate({ level: 'rotto', reason, since: since ?? null }, now, f);

  // 1. Silenzio attivo: l'ha deciso Attilio.
  if (f.mute) {
    return {
      level: 'nascosto',
      reason: f.mute.until == null ? 'silenziata per sempre' : `silenziata fino al ${calWords(Date.parse(f.mute.until))}`,
      since: Number.isNaN(Date.parse(f.mute.at)) ? null : Date.parse(f.mute.at),
    };
  }
  // 2. La prova esterna vale più dell'exit code, e anche di «spento»: un backup scaricato da launchd senza prova è il caso peggiore.
  if (proof && proof.ok === false) return rotto(proof.words || 'la prova esterna è fallita', proof.at ?? null);
  if (proof && proof.ok === null) return { level: 'te', reason: proof.words || 'non riesco a leggere la prova', since: null };
  // 3. Spento: contato, mai mostrato.
  if (item.enabled === false) return { level: 'nascosto', reason: 'spento', since: null };
  // 3. L'ultimo giro è fallito, salvo exit perdonata; saltati e corsi non sono fallimenti.
  const excused = last.outcome === 'error' && Array.isArray(desc?.okExit) && desc.okExit.includes(item.tech?.exit);
  const failed = last.delivered === 'failed' || (last.outcome === 'error' && !excused);
  const failedRun = last.outcome === 'error' && !excused;
  // 4. Serve Attilio.
  if (item.neverRan && item.fireAt != null && now - item.fireAt > H) {
    return { level: 'te', reason: `non è mai partito: doveva il ${calWords(item.fireAt)}`, since: item.fireAt };
  }
  if (item.waitingApproval) {
    const w = item.waitingApproval;
    return {
      level: 'te',
      reason: `aspetta il tuo ok al passo «${w.step}»${w.since != null ? ` da ${durWords(now - w.since)}` : ''}`,
      since: w.since ?? null,
    };
  }
  if (f.changedSinceVote && f.vote?.v === 'ok') {
    return { level: 'te', reason: 'è cambiata dopo il tuo «va bene»', since: null };
  }
  // 5. Rotto, con la soglia legata alla frequenza.
  const I = item.everyMs;
  if (failed) {
    if (!failedRun) {
      return rotto(last.at != null ? `non ti è arrivato il messaggio di ${dayTime(last.at, now)}` : 'non ti è arrivato il messaggio', last.at ?? null);
    }
    // launchd dà solo l'ultimo exit, mai la striscia: un errore è già l'ultimo giro andato male.
    if (I == null || I >= DAY || item.provider === 'launchd') {
      return rotto(last.at != null ? `ha fallito ${dayTime(last.at, now)}` : "l'ultimo giro è fallito", last.at ?? null);
    }
    if (I > 0) {
      const stated = Number.isFinite(item.consecutiveErrors) ? item.consecutiveErrors : 0;
      const streak = Math.max(stated, leadingErrors(runs, 0));
      if (streak >= needOf(I)) {
        const s = oldestErrorAt(runs, 0) ?? last.at ?? null;
        return rotto(s != null ? `sbaglia da ${durWords(now - s)} di fila` : `sbaglia da ${streak} giri di fila`, s);
      }
    }
  } else if (isOk(runs[0]) && isErr(runs[1]) && I != null && I < DAY && I > 0) {
    // Un giro buono non basta: dietro ce n'è una striscia intera.
    const behind = leadingErrors(runs, 1);
    if (behind >= needOf(I)) {
      const s = oldestErrorAt(runs, 1) ?? last.at ?? null;
      return rotto(`si sta riprendendo dopo ${behind} errori di fila: ne servono 2 buoni`, s);
    }
  }
  // In ritardo sul calendario.
  // OpenClaw tiene il prossimo giro esatto: scaduto da oltre un'ora vuol dire che non è partito.
  if (item.provider === 'openclaw' && item.next != null && !item.nextApprox && now - item.next > H) {
    return rotto(`doveva girare ${dayTime(item.next, now)} e non è partito`, item.next);
  }
  const tol = lateTolerance(I, item.provider);
  // launchd: molti job non scrivono il log a ogni giro, quindi conta il contatore dei giri che l'hub vede fermo (noRunSince).
  if (item.provider === 'launchd' && item.noRunSince != null && I != null && I > 0) {
    const missed = item.expectedLast != null
      ? item.expectedLast > item.noRunSince && now - item.expectedLast > 2 * H
      : now - item.noRunSince > I + tol;
    if (missed) return rotto(`non gira da almeno ${durWords(now - item.noRunSince)}`, item.noRunSince);
  }
  if (last.at != null && I != null && I > 0 && tol != null && now > last.at + I + tol) {
    return rotto(`non gira da ${durWords(now - (last.at + I))}`, last.at + I);
  }
  // Va e viene: riusciti e falliti si alternano.
  {
    const seq = [];
    const ats = [];
    for (const r of runs.slice(0, 10)) {
      if (r && (r.outcome === 'ok' || r.outcome === 'error')) {
        seq.push(r.outcome);
        if (r.at != null) ats.push(r.at);
      }
    }
    let changes = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) changes++;
    if (changes >= 3) {
      const s = ats.length ? Math.min(...ats) : null;
      return rotto(`va e viene: ${changes} cambi negli ultimi ${seq.length} giri`, s);
    }
  }
  return { level: 'va', reason: 'gira come deve', since: last.at ?? null };
}

const ID_RE = /\(([0-9a-fA-F]{8})\)/;
const FIND_ROTTO = new Set(['errori', 'heartbeat', 'doctor']);

// findings di cron-health `[{kind, line}]` → livelli per chiave, più righe senza job.
export function fromFindings(findings, items) {
  const byKey = new Map();
  const loose = [];
  for (const f of findings || []) {
    const line = f.line || '';
    // un avviso del doctor non è un guasto: va a te; rotto resta il doctor in errore (24/10: 4 avvisi di config finivano tra i rotti)
    const level = FIND_ROTTO.has(f.kind) && !(f.kind === 'doctor' && /^doctor warning\b/.test(line)) ? 'rotto' : 'te';
    const reason = line.replace(/\s*\([0-9a-fA-F]{8}\)/, '').replace(/\s{2,}/g, ' ').trim();
    const m = ID_RE.exec(line);
    const hit = m ? (items || []).find((it) => String(it.key || '').startsWith('cron:') && String(it.key).slice(5).startsWith(m[1])) : null;
    if (hit) {
      byKey.set(hit.key, { level, reason });
      continue;
    }
    loose.push({
      key: `health:${reason}`,
      level,
      title: f.kind === 'heartbeat' ? 'Il battito di Jarvis gira sempre'
        : f.kind === 'doctor' ? 'OpenClaw segnala un problema' : line.slice(0, 80),
      reason: line,
    });
  }
  return { byKey, loose };
}
