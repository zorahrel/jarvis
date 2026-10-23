// Aggregatore usage per la tray: un solo JSON con tutti i provider.
// Claude arriva da vdm (:3335, non toccato), gli altri da probe locali,
// i rinnovi da renewals.json manuale. Niente dipendenze.
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import { probeCodex } from "./probes/codex.mjs";
import { probeCloudCredits, creditAccount, saveLastGood, loadLastGood,
         loadCreditMap, saveCreditMap, mergeCreditMap } from "./probes/cloud-credit.mjs";
import { probeEleven } from "./probes/hub.mjs";
import { probeAnthropicApi, probeAnthropicConsole } from "./probes/anthropic-api.mjs";
import { createHistory, attachHistory, defaultHistoryPath } from "./history.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3337;
const API_SPEND_FILE = process.env.VDM_API_SPEND_FILE ||
  path.join(homedir(), ".claude", "account-switcher", "api-spend.json");

// Archivio temporale delle quote (history.mjs): caricato pigro alla prima
// overview, mai a import (i test importano questo modulo senza fs).
const history = createHistory(process.env.USAGE_HISTORY_PATH || defaultHistoryPath());

function resetText(epochSec) {
  if (!epochSec) return "";
  const secs = epochSec - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "ora";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function statusFor(usedPct, override) {
  if (override) return override;
  if (usedPct >= 100) return "depleted";
  if (usedPct >= 95) return "critical";
  if (usedPct >= 80) return "warning";
  return "ok";
}

const SPEND_DAY_FORMAT = new Intl.DateTimeFormat("en", {
  timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
});

function spendDayKey(now) {
  const parts = Object.fromEntries(SPEND_DAY_FORMAT.formatToParts(new Date(now))
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftSpendDay(day, offset) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
}

function spendRound(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function formatApiSpendLine(summary) {
  const amount = (value) => Number(value || 0).toFixed(2);
  // Le voci per chiave sono sempre finestre 7d, come il totale settimanale.
  const warning = Number(summary.last7d) > 20 ? " ⚠️" : "";
  const keys = Object.entries(summary.perKey)
    .map(([key, row]) => `${key} $${amount(row.last7d)}`).join(", ");
  return `API Claude: $${amount(summary.today)} oggi · $${amount(summary.last7d)} 7g${keys ? ` (${keys})` : ""}${warning}`;
}

export function readApiSpend(file = API_SPEND_FILE, now = Date.now()) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data?.version !== 1 || !data.days || typeof data.days !== "object" || Array.isArray(data.days)) return null;
    const todayKey = spendDayKey(now);
    const weekStart = shiftSpendDay(todayKey, -6);
    const total = { today: 0, last7d: 0, sinceOct16: 0 };
    const perKey = {};
    for (const [day, keys] of Object.entries(data.days)) {
      if (day > todayKey) continue;
      for (const [key, models] of Object.entries(keys || {})) {
        const cost = Object.values(models || {}).reduce((sum, row) => sum + Number(row?.cost || 0), 0);
        const entry = perKey[key] ??= { today: 0, last7d: 0, sinceOct16: 0 };
        if (day >= "2026-10-16") { entry.sinceOct16 += cost; total.sinceOct16 += cost; }
        if (day === todayKey) { entry.today += cost; total.today += cost; }
        if (day >= weekStart) { entry.last7d += cost; total.last7d += cost; }
      }
    }
    const summary = {
      currency: "USD",
      today: spendRound(total.today),
      last7d: spendRound(total.last7d),
      sinceOct16: spendRound(total.sinceOct16),
      perKey: Object.fromEntries(Object.entries(perKey).map(([key, amounts]) => [key, {
        today: spendRound(amounts.today), last7d: spendRound(amounts.last7d), sinceOct16: spendRound(amounts.sinceOct16),
      }])),
    };
    summary.line = formatApiSpendLine(summary);
    return summary;
  } catch { return null; }
}

// vdm interroga Anthropic dentro /api/profiles: misurato da 0,5 a 27s (14/10).
// Un giro lento non deve svuotare Claude ("vdm offline", zero account): si
// ripiega sull'ultima risposta buona finché ha meno di 15 minuti.
const VDM_TIMEOUT_MS = 20000;
const VDM_FALLBACK_MS = 15 * 60 * 1000;
let lastVdm = null; // { at, data }

export async function fetchVdm({ fetchImpl = fetch, now = Date.now(), timeoutMs = VDM_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl("http://localhost:3335/api/profiles", { signal: ctrl.signal });
    if (!res.ok) throw new Error(`vdm ${res.status}`);
    const data = await res.json();
    lastVdm = { at: now, data };
    return data;
  } catch (e) {
    if (lastVdm && now - lastVdm.at < VDM_FALLBACK_MS) return lastVdm.data;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Codice menubar: prime 3 alfanumeriche in maiuscolo (ATT, COD, CUR, MUS).
function code3(label) {
  return String(label || "?").replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase().padEnd(3, "·");
}

const STATUS_RANK = { off: 0, ok: 1, warning: 2, error: 3, critical: 4, depleted: 5 };

function mapClaude(vdm) {
  const accounts = (vdm.profiles || []).map((p) => {
    const u5 = (p.rateLimits?.fiveH?.utilization ?? 0) * 100;
    const u7 = (p.rateLimits?.sevenD?.utilization ?? 0) * 100;
    const r5 = p.rateLimits?.fiveH?.reset ?? null;
    const r7 = p.rateLimits?.sevenD?.reset ?? null;
    const qStatus = (key, u) => {
      let override = null;
      if (p.disabled) override = "off";
      else if (p.blockKind === "quota-5h" && key === "5h") override = "depleted";
      else if (p.blockKind === "quota-7d" && key === "7d") override = "depleted";
      else if (p.blockKind === "model") override = "warning";
      else if (p.blockKind === "auth") override = "error";
      return statusFor(u, override);
    };
    const s5 = qStatus("5h", u5);
    const s7 = qStatus("7d", u7);
    return {
      id: p.label || p.name,
      label: String(p.label || p.name),
      code: code3(p.label || p.name),
      active: p.isActive === true,
      status: STATUS_RANK[s5] >= STATUS_RANK[s7] ? s5 : s7,
      quotas: [
        { key: "5h", usedPct: Math.round(u5), resetsAt: r5, resetText: resetText(r5), status: s5 },
        { key: "7d", usedPct: Math.round(u7), resetsAt: r7, resetText: resetText(r7), status: s7 },
      ],
      // Reset manuali Claude: promo una tantum senza API (solo card in
      // Settings → Usage su web/Desktop), quindi ignoti: null, mai zero.
      resetCredits: null,
    };
  });
  return { id: "claude", name: "Claude", accounts };
}

function runProbe(script) {
  return new Promise((resolve) => {
    execFile("python3", [path.join(DIR, script)], { timeout: 25000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

function toEpoch(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

// Oltre 10 minuti (due giri di cache della sonda) il dato Muse è vecchio: grigio
// e con l'età, mai spacciato per attuale (09/10: tray su 80% con quota a 101%).
const MUSE_STALE_S = 600;

function staleText(asOf, now = Math.floor(Date.now() / 1000)) {
  const m = Math.floor((now - asOf) / 60);
  return m < 60 ? `dato di ${m}m fa` : `dato di ${Math.floor(m / 60)}h fa`;
}

function mapMuse(out, now = Math.floor(Date.now() / 1000)) {
  // Da Muse 1.4.4 il mint può confermare l'account ma omettere subs_usage.
  // Manteniamo l'account nel tray e dichiariamo l'assenza: sparire sarebbe
  // ambiguo, inventare una percentuale sarebbe peggio.
  const hasAccount = typeof out?.email === "string" && out.email.includes("@");
  if (!out || !Array.isArray(out.quotas) || out.quotas.length === 0) {
    if (!hasAccount) return { id: "muse", name: "Muse", error: "nessun dato" };
    return { id: "muse", name: "Muse", error: "Muse non pubblica la quota",
             accounts: [{ id: "muse-code", label: out.email, code: code3("Muse"),
                          active: true, status: "stale", quotas: [], resetCredits: null }] };
  }
  const stale = typeof out.asOf === "number" && now - out.asOf > MUSE_STALE_S;
  const quotas = out.quotas.map((q) => {
    const used = Math.round(100 - (q.percentRemaining ?? 0));
    const resetsAt = toEpoch(q.resetsAt);
    return { key: q.type === "session" ? "5h" : q.type === "weekly" ? "7d" : q.type,
             usedPct: used, resetsAt,
             resetText: stale ? staleText(out.asOf, now) : resetText(resetsAt),
             status: stale ? "stale" : statusFor(used, null),
             // Istante della lettura vera: a dato vecchio lo storico deve
             // collocarlo lì, non quando questa overview lo rilegge.
             observedAt: typeof out.asOf === "number" ? out.asOf : undefined };
  });
  const worst = Math.max(...quotas.map((q) => q.usedPct));
  const email = out.email;
  const label = typeof email === "string" && email.includes("@") ? email : "Muse";
  return { id: "muse", name: "Muse",
           accounts: [{ id: "muse-code", label, code: code3("Muse"), active: true,
                        status: stale ? "stale" : statusFor(worst, null), quotas, resetCredits: null }] };
}

function mapQuotas(out, id, name, accountId, accountLabel, email = null) {
  if (!out || !Array.isArray(out.quotas) || out.quotas.length === 0) {
    return { id, name, error: "nessun dato" };
  }
  const quotas = out.quotas.map((q) => {
    const usedPct = Math.round(q.usedPct ?? 0);
    return { key: q.key, usedPct, resetsAt: q.resetsAt ?? null,
             resetText: resetText(q.resetsAt ?? null), status: statusFor(usedPct, null) };
  });
  const worst = Math.max(...quotas.map((q) => q.usedPct));
  const label = typeof email === "string" && email.includes("@") ? email : accountLabel;
  return { id, name, accounts: [{ id: accountId, label,
    code: code3(accountLabel),
    active: true, status: statusFor(worst, null), quotas,
    resetCredits: out.resetCredits ?? null }] };
}

// Decide la riga credito: live → salva e serve; in mancanza → stantio
// con età (anche se il tool è sparito: l'età dice quanto vale); senza
// niente → riga "in aggiornamento" o sezione nascosta. Una sonda stale
// (ultimo buono in cache) si serve con la SUA età, mai risalvata: il
// salvataggio la ringiovanirebbe a "adesso".
export function mergeCredit(probe, last) {
  if (probe && !probe.unavailable && !probe.nobonus) {
    return { credit: probe, save: probe.stale ? null : probe };
  }
  if (last) return { credit: last, save: null };
  if (probe?.unavailable) return { credit: probe, save: null };
  return { credit: null, save: null };
}

// Numeri corti per le righe hub: 45300 → "45k", 1200 → "1.2k", 1.05 → "1.05".
export function shortNum(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) {
    const k = Math.round(n / 100) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  if (n >= 100) return `${Math.round(n)}`;
  return `${Math.round(n * 100) / 100}`;
}

const HUB_ERRORS = {
  nokey: "chiave assente nel keychain",
  noperm: "chiave senza permesso user_read",
  rejected: "chiave rifiutata",
  timeout: "timeout",
};

// Provider hub (solo menu, a consumo): quote con numeri assoluti nel
// detail ("$1.05 su $50"). Senza dati: la riga dice cosa manca. Senza
// tetto la percentuale non esiste: status "unknown", mai uno 0% finto.
export function mapHub(id, name, out) {
  const base = { id, name, menuOnly: true, billing: "usage" };
  if (!out || out.error || !Array.isArray(out.quotas) || out.quotas.length === 0) {
    const err = out?.error;
    const text = HUB_ERRORS[err] ?? (typeof err === "string" && err.startsWith("http")
      ? `HTTP ${err.slice(4)}` : "nessun dato");
    return { ...base, error: text };
  }
  const withUnit = (v, u) => (u === "$" ? `$${v}` : `${v}${u}`);
  const quotas = out.quotas.map((q) => {
    const usedPct = q.limit > 0 ? Math.round((q.used / q.limit) * 100) : 0;
    const resetsAt = typeof q.reset === "number" ? q.reset : toEpoch(q.reset);
    const detail = q.limit > 0
      ? `${withUnit(shortNum(q.used), q.unit)} su ${withUnit(shortNum(q.limit), q.unit)}`
      : `${withUnit(shortNum(q.used), q.unit)} spesi`;
    return { key: q.key, usedPct, resetsAt,
             resetText: q.resetWord ?? resetText(resetsAt),
             status: q.limit > 0 ? statusFor(usedPct, null) : "unknown", detail };
  });
  const label = typeof out.label === "string" && out.label ? out.label : name;
  const worst = Math.max(...quotas.map((q) => q.usedPct));
  return { ...base, accounts: [{ id, label, code: code3(label), active: true,
    status: statusFor(worst, null), quotas, resetCredits: null }] };
}

// Profili vdm con Max: il bonus cloud spetta a ognuno, la sonda li gira
// tutti via CLOUD_ACCOUNT. Senza vdm: un giro sul login corrente.
export function bonusTargets(vdm) {
  return (vdm?.profiles ?? [])
    .filter((p) => p?.subscriptionType === "max" && p?.name && p?.label)
    .map((p) => ({ name: p.name, email: p.label }));
}

async function overview() {
  let renewals = [];
  try {
    // Tutte, anche tray:false: le righe Abbonamento sotto gli account
    // live le usano comunque, la tray nasconde solo orfani e gruppi.
    const raw = JSON.parse(await readFile(path.join(DIR, "renewals.json"), "utf8"));
    renewals = Array.isArray(raw) ? raw : [];
  } catch { /* resta vuoto */ }
  // vdm prima (locale, millisecondi): i nomi dei profili servono alla
  // sonda multipla. Il resto in parallelo: in sequenza supera i 55s della tray.
  const vdm = await fetchVdm().catch(() => null);
  const [cx, museOut, probed, elOut, apiOut] = await Promise.all([
    probeCodex(),
    runProbe("muse_probe.py"),
    probeCloudCredits(vdm ? bonusTargets(vdm) : []),
    probeEleven(),
    probeAnthropicConsole().then((o) => (o.error ? probeAnthropicApi() : o)),
  ]);
  const providers = [];
  providers.push(vdm
    ? mapClaude(vdm)
    : { id: "claude", name: "Claude", error: "vdm offline" });
  providers.push(mapQuotas(cx, "codex", "Codex", "codex", "Codex", cx?.email));
  providers.push(mapMuse(museOut));
  // Hub: solo con dati veri (niente righe d'errore, niente progetti altrui).
  // OpenRouter tolto (18/10): la chiave è di Cifra, solo per i prodotti; nemmeno la tray la legge.
  for (const [id, name, out] of [["elevenlabs", "ElevenLabs", elOut]]) {
    if (out && !out.error) providers.push(mapHub(id, name, out));
  }
  // Speso API sotto il SUO account Claude (è dell'org del proprietario, come il
  // bonus cloud: sezione propria duplicherebbe e confonde).
  attachApiSpend(providers, apiOut);
  const login = creditAccount();
  const merged = mergeCredit(probed.find((p) => p.account === login) ?? null, loadLastGood());
  if (merged.save) saveLastGood(merged.save);
  let cmap = mergeCreditMap(loadCreditMap(), null);
  const liveNow = new Set();
  for (const item of probed) {
    cmap = mergeCreditMap(cmap.map, item);
    if (cmap.changed) saveCreditMap(cmap.map);
    if (item && typeof item.remaining === "number" && !item.stale &&
        typeof item.account === "string" && item.account.includes("@")) liveNow.add(item.account);
  }
  // Ogni merge segna fresco solo il suo giro: il poll ne ha fatti tanti.
  for (const email of liveNow) {
    if (cmap.credits[email]) cmap.credits[email] = { ...cmap.credits[email], stale: false };
  }
  // Storico: registra il campione di adesso e allega a ogni quota la sua
  // serie (log nostro + vdm per Claude). Mai bloccante: se salta, la tray
  // mostra le solite barre senza sparkline.
  try {
    history.record(providers);
    attachHistory(providers, vdm, history.samples());
  } catch { /* overview vince sempre */ }
  return { ok: true, at: Date.now(), providers, renewals,
           credit: merged.credit, credits: cmap.credits, apiSpend: readApiSpend() };
}

function filterRenewals(list) {
  return (Array.isArray(list) ? list : []).filter((r) => r.tray !== false);
}

let cache = { at: 0, body: null };
const CACHE_MS = 45000;
let inflight = null; // una sola overview in volo: niente probe doppie

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/overview") {
    try {
      if (!cache.body || Date.now() - cache.at > CACHE_MS) {
        inflight ??= overview().then(
          (o) => { cache = { at: Date.now(), body: JSON.stringify(o) }; },
        ).finally(() => { inflight = null; });
        await inflight;
      }
      const body = cache.body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }
  res.writeHead(404);
  res.end("nope");
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () => console.log(`usage-server :${PORT}`));
}

// Speso API Anthropic appeso all'account Claude che lo possiede
// (l'etichetta arriva dalla sonda): la tray lo disegna lì sotto, niente sezione hub.
// Riga come il bonus cloud: barra = speso/concesso, detail = saldo
// ("$X rimasti"), resetsAt = SCADENZA del credito (la tray scrive "scade
// gg/mm", niente ↻). Speso, concesso e ora di lettura vanno in note (tooltip).
export function attachApiSpend(providers, apiOut) {
  if (!apiOut || apiOut.error) return providers;
  if (apiOut.live) {
    const { spent, remaining, granted, expiresAt, asOf } = apiOut.live;
    const claude = (providers ?? []).find((p) => p?.id === "claude");
    const mine = claude?.accounts?.find((a) => a?.label === apiOut.label);
    if (mine) {
      const usedPct = granted > 0 ? Math.round((spent / granted) * 100) : 0;
      const resetsAt = toEpoch(expiresAt);
      const time = new Date(asOf * 1000).toLocaleTimeString("it-IT",
        { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
      mine.apiSpend = { key: "API", usedPct, resetsAt, resetText: "",
        status: statusFor(usedPct, null),
        detail: `$${remaining.toFixed(2)} rimasti`,
        note: `$${spent.toFixed(2)} spesi su $${granted.toFixed(2)} · letto alle ${time}` };
    }
    return providers;
  }
  if (apiOut.snapshot) {
    const snapshot = apiOut.snapshot;
    const claude = (providers ?? []).find((p) => p?.id === "claude");
    const mine = claude?.accounts?.find((a) => a?.label === apiOut.label);
    if (mine) {
      const dm = (d) => d.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit" });
      const observed = new Date(snapshot.asOf * 1000);
      const date = dm(observed);
      const time = observed.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
      const expires = toEpoch(snapshot.expiresAt);
      // Lettura a mano: niente rapporto (status unknown → "—"), la data di
      // lettura resta in vista perché il saldo può essere vecchio.
      mine.apiSpend = { key: "API", usedPct: 0, resetsAt: null, resetText: "", status: "unknown",
        detail: `$${snapshot.remaining.toFixed(2)} rilevati ${date}`,
        note: `saldo letto a mano ${date} ${time} · solo API/SDK`
          + (expires ? ` · scade ${dm(new Date(expires * 1000))}` : "") };
    }
    return providers;
  }
  const shaped = mapHub("anthropic-api", "Anthropic API", apiOut);
  if (shaped.error || !shaped.accounts?.[0]?.quotas?.[0]) return providers;
  const claude = (providers ?? []).find((p) => p?.id === "claude");
  const mine = claude?.accounts?.find((a) => a?.label === apiOut.label);
  if (mine) mine.apiSpend = shaped.accounts[0].quotas[0];
  return providers;
}

export { resetText, statusFor, mapClaude, mapMuse, mapQuotas, filterRenewals, toEpoch, overview, code3 };
