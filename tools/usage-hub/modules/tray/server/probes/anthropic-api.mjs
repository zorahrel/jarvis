// Saldo API Anthropic. Prima dal vivo: l'endpoint che la pagina Billing
// della console usa (/prepaid/credits), col cookie di sessione nel Keychain.
// L'org dell'account è "Individual": le Admin key (e quindi cost_report) non
// esistono. Fallback: ultimo saldo letto a mano nella console.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { loadLocal } from "../local-config.mjs";

// Account, organizzazione e voce del Keychain stanno nel file locale (local-config.mjs), mai nel repo.
const cfg = () => ({ account: "", org: "", keychainAccount: "", ...loadLocal().api });
// Il credito si consuma in ore, non in secondi: un giro ogni 15 minuti.
const LIVE_TTL_MS = 15 * 60 * 1000;
let liveCache = { at: 0, out: null };

function keychain(service, account) {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"],
      { timeout: 10000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

// Il grant promozionale "API credit" del Max: speso = concesso - residuo.
export function parseConsoleCredits(data, now = Date.now()) {
  const tranches = Array.isArray(data?.promo_tranches) ? data.promo_tranches : [];
  const live = tranches.filter((t) => Number.isFinite(t?.granted_amount_minor_units) &&
    Number.isFinite(t?.remaining_amount_minor_units) && Date.parse(t.expires_at) > now);
  if (live.length === 0) return null;
  const granted = live.reduce((a, t) => a + t.granted_amount_minor_units, 0) / 100;
  const remaining = live.reduce((a, t) => a + t.remaining_amount_minor_units, 0) / 100;
  const expiresAt = live.map((t) => t.expires_at).sort()[0];
  return { granted, remaining, spent: Math.round((granted - remaining) * 100) / 100, expiresAt };
}

export async function probeAnthropicConsole({ fetchImpl = fetch, cookie } = {}) {
  if (liveCache.out && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.out;
  const { account, org, keychainAccount } = cfg();
  if (!account || !org) return { error: "nokey" };
  const sk = cookie ?? await keychain("anthropic/console-session", keychainAccount);
  if (!sk) return { error: "nokey" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetchImpl(`https://platform.claude.com/api/organizations/${org}/prepaid/credits`,
      { headers: { cookie: `sessionKey=${sk}` }, signal: ctrl.signal });
    if (!res.ok) return { error: classifyAnthropicError(res.status, null) };
    const credits = parseConsoleCredits(await res.json());
    if (!credits) return { error: "nodata" };
    const out = { label: account, live: { ...credits, asOf: Math.floor(Date.now() / 1000) } };
    liveCache = { at: Date.now(), out };
    return out;
  } catch { return { error: "timeout" }; } finally { clearTimeout(t); }
}

// Somma gli amount (centesimi, stringhe decimali) di tutte le pagine.
export function sumCostReport(pages) {
  if (!Array.isArray(pages)) return 0;
  let total = 0;
  for (const p of pages) {
    if (!p || !Array.isArray(p.data)) continue;
    for (const bucket of p.data) {
      if (!bucket || !Array.isArray(bucket.results)) continue;
      for (const r of bucket.results) {
        const v = Number(r?.amount);
        if (Number.isFinite(v)) total += v / 100;
      }
    }
  }
  return Math.round(total * 100) / 100;
}

export function classifyAnthropicError(status, data) {
  if (status === 0) return "timeout";
  if (status === 401 || status === 403) {
    const body = JSON.stringify(data) ?? "";
    if (/admin|permission|scope/i.test(body)) return "noperm";
    return "rejected";
  }
  return `http${status}`;
}

// Il cost_report misura lo speso, non i grant spendibili per prodotto. Un
// report vuoto non autorizza a mostrare "$200 disponibili". La console
// distingue inoltre API/Agent SDK da Claude Code interattivo.
export async function probeAnthropicApi(file = new URL("../anthropic-balances.json", import.meta.url)) {
  try {
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    if (snapshot.source !== "console" || typeof snapshot.account !== "string" ||
        !Number.isFinite(snapshot.remaining) || snapshot.remaining < 0 ||
        !Number.isInteger(snapshot.asOf) || !snapshot.expiresAt) return { error: "nodata" };
    if (Date.now() >= Date.parse(snapshot.expiresAt)) return { error: "expired" };
    return { label: snapshot.account, snapshot };
  } catch { return { error: "nodata" }; }
}
