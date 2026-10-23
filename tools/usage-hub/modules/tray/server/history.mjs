// Storico temporale delle quote: quando la quota è stata spesa, non solo
// quanta ne resta. Due fonti, una serie per quota:
// - vdm (solo Claude): utilizationHistory (rolling ~24h) + weeklyHistory.
//   Serie volatili: viste ripartire da 1 punto al cambio account attivo,
//   quindi fanno da bootstrap, non da archivio.
// - log nostro append-only (tutti i provider, Claude incluso): un campione
//   compatto a ogni overview fresca, tenuto per sempre. La decimazione
//   avviene solo in lettura, per la sparkline.
// Lo storico è un extra: nessun errore qui deve mai rompere overview.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultHistoryPath() {
  // Application Support, non .cache: è un archivio, macOS può purgare le cache.
  return path.join(os.homedir(), "Library", "Application Support",
                   "claude-usage-tray", "history.jsonl");
}

// Finestra mostrata per quota. La 5h si guarda su 24h: il suo usedPct è già
// relativo alla finestra mobile, su un giorno si vede il ritmo di spesa
// (salite e reset), che è la domanda "quando spendo". Hub e API sono a
// consumo mensile: 30 giorni.
export function quotaWindowSec(key) {
  switch (String(key || "").toLowerCase()) {
    case "5h": return 86400;
    case "api": case "usd": case "chr": return 30 * 86400;
    default: return 7 * 86400; // 7d e chiavi ignote
  }
}

function sampleKey(providerId, accountLabel, quotaKey) {
  return `${providerId}|${accountLabel}|${quotaKey}`;
}

// Campioni compatti: {t, s: {"provider|account|quota": usedPct}}.
// Una quota con observedAt (Muse da cache) sta al suo istante vero, non a
// quello di lettura: raggruppare tutto a "adesso" fabbricava piatti e salti
// nel punto sbagliato. "unknown" non è una misura, "stale" senza istante
// non è collocabile: fuori entrambi.
export function samplesFromProviders(providers, nowSec) {
  const byTime = new Map();
  for (const p of providers ?? []) {
    for (const a of p?.accounts ?? []) {
      const quotas = [...(a.quotas ?? []), ...(a.apiSpend ? [a.apiSpend] : [])];
      for (const q of quotas) {
        if (!q || q.status === "unknown"
            || typeof q.usedPct !== "number" || !Number.isFinite(q.usedPct)) continue;
        const seen = typeof q.observedAt === "number"
          && Number.isFinite(q.observedAt) && q.observedAt > 0;
        if (q.status === "stale" && !seen) continue;
        const t = seen ? Math.min(Math.floor(q.observedAt), nowSec) : nowSec;
        if (!byTime.has(t)) byTime.set(t, {});
        byTime.get(t)[sampleKey(p.id, a.label, q.key)] = q.usedPct;
      }
    }
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, s]) => ({ t, s }));
}

// Per-serie: si registra a ogni cambiamento; a valore fermo basta un
// heartbeat ogni 15 minuti, così un piatto è distinto da un buco (Mac
// spento). Un candidato già presente allo stesso istante è un doppione:
// è il caso della cache Muse riletta a ogni poll col suo asOf fisso.
const HEARTBEAT_S = 900;
function filterCandidate(samples, candidate) {
  const s = {};
  for (const [key, value] of Object.entries(candidate.s)) {
    let prior = null;
    let seenAtSameTime = false;
    for (const sample of samples) {
      if (sample.t > candidate.t) break;
      if (Object.prototype.hasOwnProperty.call(sample.s, key)) {
        prior = sample;
        if (sample.t === candidate.t) seenAtSameTime = true;
      }
    }
    if (seenAtSameTime) continue;
    if (!prior || prior.s[key] !== value
        || candidate.t - prior.t >= HEARTBEAT_S) s[key] = value;
  }
  return Object.keys(s).length ? { t: candidate.t, s } : null;
}

// Riga corrotta (crash a metà append) saltata, mai fatale.
export function parseHistory(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o.t === "number" && o.s && typeof o.s === "object") out.push(o);
    } catch { /* riga persa, il resto vale */ }
  }
  return out.sort((a, b) => a.t - b.t);
}

// Decimazione che conserva min e max di ogni fascia: quella uniforme
// saltava i picchi brevi e appiattiva la curva anche dove spesa c'era stata.
export function decimate(points, max = 72) {
  if (!Array.isArray(points) || points.length <= max) return points ?? [];
  if (max <= 2) return [points[0], points[points.length - 1]];
  const chosen = new Set([0, points.length - 1]);
  const bucketCount = Math.floor((max - 2) / 2);
  if (bucketCount < 1) {
    // max = 3: in mezzo solo l'estremo più lontano dagli estremi.
    let best = 1, bestDist = -1;
    for (let i = 1; i < points.length - 1; i++) {
      const d = Math.max(Math.abs(points[i].v - points[0].v),
                         Math.abs(points[i].v - points[points.length - 1].v));
      if (d > bestDist) { bestDist = d; best = i; }
    }
    chosen.add(best);
  } else {
    const start = 1, end = points.length - 1;
    for (let b = 0; b < bucketCount; b++) {
      const from = start + Math.floor(b * (end - start) / bucketCount);
      const to = start + Math.floor((b + 1) * (end - start) / bucketCount);
      if (to <= from) continue;
      let lo = from, hi = from;
      for (let i = from; i < to; i++) {
        if (points[i].v < points[lo].v) lo = i;
        if (points[i].v > points[hi].v) hi = i;
      }
      chosen.add(lo);
      chosen.add(hi);
    }
  }
  return [...chosen].sort((a, b) => a - b).map((i) => points[i]);
}

export function seriesFromSamples(samples, providerId, accountLabel, quotaKey,
                                  windowSec, nowSec) {
  const k = sampleKey(providerId, accountLabel, quotaKey);
  const from = nowSec - windowSec;
  const pts = [];
  for (const s of samples ?? []) {
    const v = s?.s?.[k];
    if (s.t >= from && typeof v === "number" && Number.isFinite(v)) pts.push({ t: s.t, v });
  }
  return pts;
}

// Serie vdm di un profilo Claude: u è 0..1, qui diventa % con un decimale.
export function vdmSeries(profile, quotaKey, windowSec, nowSec) {
  const field = quotaKey === "5h" ? "u5h" : quotaKey === "7d" ? "u7d" : null;
  if (!field || !profile) return [];
  const from = nowSec - windowSec;
  const byT = new Map();
  for (const pool of [profile.utilizationHistory, profile.weeklyHistory]) {
    for (const e of Array.isArray(pool) ? pool : []) {
      const t = Math.floor((e?.ts ?? 0) / 1000);
      const u = e?.[field];
      if (t >= from && typeof u === "number" && Number.isFinite(u)) {
        byT.set(t, { t, v: Math.round(u * 1000) / 10 });
      }
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// Fonde log (intero, durevole) e vdm (decimale, volatile): a parità di
// istante (±90s) vince vdm, più preciso; il resto convive in ordine.
// Collasso sequenziale, non a bucket: due punti vicini a cavallo di un
// bordo di bucket resterebbero entrambi (visto dal test).
export function mergeSeries(logPts, vdmPts) {
  const tagged = [
    ...(logPts ?? []).map((p) => ({ ...p, vdm: false })),
    ...(vdmPts ?? []).map((p) => ({ ...p, vdm: true })),
  ].sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of tagged) {
    const last = out[out.length - 1];
    if (last && p.t - last.t <= 90) {
      if (p.vdm && !last.vdm) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out.map(({ t, v }) => ({ t, v }));
}

// Allega quota.history (≥2 punti: con uno non si disegna niente di onesto).
export function attachHistory(providers, vdm, samples,
                              nowSec = Math.floor(Date.now() / 1000)) {
  const profileByLabel = new Map(
    (vdm?.profiles ?? []).map((p) => [p?.label, p]));
  for (const p of providers ?? []) {
    for (const a of p?.accounts ?? []) {
      const quotas = [...(a.quotas ?? []), ...(a.apiSpend ? [a.apiSpend] : [])];
      for (const q of quotas) {
        if (!q?.key) continue;
        const win = quotaWindowSec(q.key);
        const logPts = seriesFromSamples(samples, p.id, a.label, q.key, win, nowSec);
        const vdmPts = p.id === "claude"
          ? vdmSeries(profileByLabel.get(a.label), q.key, win, nowSec) : [];
        const pts = decimate(mergeSeries(logPts, vdmPts));
        if (pts.length >= 2) q.history = pts;
      }
    }
  }
  return providers;
}

// Wrapper con stato: carica il file una volta (pigro), poi appende.
// Ogni errore fs è ingoiato: overview risponde comunque.
export function createHistory(filePath) {
  let samples = null;
  const load = () => {
    if (samples) return samples;
    samples = [];
    try {
      if (existsSync(filePath)) samples = parseHistory(readFileSync(filePath, "utf8"));
    } catch { /* si riparte da vuoto */ }
    return samples;
  };
  return {
    samples: load,
    record(providers, nowSec = Math.floor(Date.now() / 1000)) {
      const all = load();
      let recorded = false;
      try { mkdirSync(path.dirname(filePath), { recursive: true }); }
      catch { /* i campioni restano in RAM per questa sessione */ }
      for (const candidate of samplesFromProviders(providers, nowSec)) {
        const next = filterCandidate(all, candidate);
        if (!next) continue;
        // Inserimento in ordine: un punto stale col suo observedAt può
        // precedere campioni già presenti. Su file resta append-only,
        // parseHistory riordina alla rilettura.
        const at = all.findIndex((s) => s.t > next.t);
        if (at < 0) all.push(next); else all.splice(at, 0, next);
        try { appendFileSync(filePath, JSON.stringify(next) + "\n"); }
        catch { /* il campione resta in RAM per questa sessione */ }
        recorded = true;
      }
      return recorded;
    },
  };
}
