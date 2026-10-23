// Bonus cloud Max ($250 una tantum): saldo vivo da `credito-cloud --json`
// (tool personale in ~/bin, non committato), un giro con CLOUD_ACCOUNT per
// ogni profilo Max in vdm. Vivo o niente: il bucket in
// ~/.claude.json è fermo da giorni, quindi niente fallback su file stantio.
// Ultimo buono su /tmp (max 6h) con età; assente → sezione nascosta.
// Niente dipendenze.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const QUIET_PATH = "/tmp/usage-credit-fail"; // live fallito: riprova tra 10'
const QUIET_MS = 600000;
const FRESH_PATH = "/tmp/usage-credit-fresh"; // live ok: non richiamare per 15'
const FRESH_MS = 900000;
const NOBONUS_PATH = "/tmp/usage-credit-nobonus"; // "email|ts": login senza bonus
const NOBONUS_MS = 900000;
const LAST_PATH = "/tmp/usage-credit-last.json"; // ultimo buono, max 6h
const LAST_TTL_MS = 6 * 3600 * 1000;
// Marcatori per profilo vdm: condividerli attribuirebbe a un account il
// saldo dell'altro. Il giro senza nome usa i percorsi storici.
const tag = (base, name) => (name ? `${base}-${name}` : base);
// Ultimo buono PER ACCOUNT (la sonda legge solo il login corrente, che
// ruota): email → {remaining, limit, used, renewsAt, asOf} oppure
// {nobonus: true, asOf}. Senza scadenza: si mostra con la sua età.
const CREDIT_MAP_PATH = path.join(os.homedir(), ".cache", "claude-usage-tray", "credit-last.json");

export function parseCloudCredit(out) {
  const b = out?.iguana_necktie;
  if (!b || typeof b.remaining_dollars !== "number") return null;
  const m = typeof b.resets_at === "string" && b.resets_at.match(/^(\d{4}-\d{2}-\d{2})/);
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    remaining: r2(b.remaining_dollars),
    limit: typeof b.limit_dollars === "number" ? r2(b.limit_dollars) : null,
    used: typeof b.used_dollars === "number" ? r2(b.used_dollars) : null,
    renewsAt: m ? m[1] : null,
  };
}

// Il bonus è dell'account loggato (quello attivo in vdm): stessa sorgente
// che usa credito-cloud, l'email in ~/.claude.json → oauthAccount.
export function creditAccount(home = os.homedir()) {
  try {
    const j = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    const email = j?.oauthAccount?.emailAddress;
    return typeof email === "string" && email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

// Tre esiti, tre comportamenti in menu: live → riga col saldo; nobonus
// (login senza bonus, es. dopo rotazione vdm) → sezione nascosta;
// failed (429, rete) → riga "in aggiornamento".
export function classifyCreditOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "failed" };
  }
  if (parsed && typeof parsed === "object" && parsed.iguana_necktie == null) {
    return { kind: "nobonus" };
  }
  const value = parseCloudCredit(parsed);
  return value ? { kind: "live", value } : { kind: "failed" };
}

// Perché il live è fallito: exit 3 = token scaduto (contratto di
// credito-cloud), 429 = throttle, il resto = errore generico.
export function reasonForFailure(err, stdout, stderr) {
  if (err?.code === 3) return "token";
  if (/429/.test(`${stdout ?? ""}${stderr ?? ""}`)) return "limited";
  return "error";
}

function freshStamp(p) {
  try {
    return Number(readFileSync(p, "utf8")) || 0;
  } catch {
    return 0;
  }
}
const isFresh = (p, ttl, now = Date.now()) => now - freshStamp(p) < ttl;

function mark(p, content = null) {
  try {
    writeFileSync(p, content ?? String(Date.now()));
  } catch { /* tmp non scrivibile: si riprova sempre, nessun danno */ }
}

export function liveQuiet(failPath = QUIET_PATH, now = Date.now()) {
  return isFresh(failPath, QUIET_MS, now);
}

// Il nobonus vale solo per quel login: se vdm ha ruotato si riprova subito.
export function nobonusQuiet(login, p = NOBONUS_PATH, now = Date.now()) {
  try {
    const [email, ts] = readFileSync(p, "utf8").split("|");
    return email === login && now - Number(ts) < NOBONUS_MS;
  } catch {
    return false;
  }
}

export function loadCreditMap(mapPath = CREDIT_MAP_PATH) {
  try {
    const m = JSON.parse(readFileSync(mapPath, "utf8"));
    if (!m || typeof m !== "object" || Array.isArray(m)) return {};
    return m;
  } catch {
    return {};
  }
}

export function saveCreditMap(map, mapPath = CREDIT_MAP_PATH) {
  try {
    mkdirSync(path.dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, JSON.stringify(map));
  } catch { /* cache non scrivibile: solo live, nessun danno */ }
}

// Fonde l'esito della sonda nella mappa: live → scrive (fresco) o fissa
// l'età se è cache recente; nobonus → segna l'account senza bonus; il
// resto (429, token, tool assente) non tocca niente. Ogni voce non letta
// in questo giro esce con stale: true, pronta per la tray.
export function mergeCreditMap(map, probed, nowSec = Math.floor(Date.now() / 1000)) {
  const next = { ...(map && typeof map === "object" && !Array.isArray(map) ? map : {}) };
  const acct = probed?.account;
  const keyed = typeof acct === "string" && acct.includes("@") ? acct : null;
  let liveLogin = null;
  let changed = false;
  if (keyed && probed && typeof probed.remaining === "number") {
    if (!probed.stale) {
      next[keyed] = { remaining: probed.remaining, limit: probed.limit ?? null,
        used: probed.used ?? null, renewsAt: probed.renewsAt ?? null, asOf: nowSec };
      liveLogin = keyed;
      changed = true;
    } else if (!next[keyed]) {
      next[keyed] = { remaining: probed.remaining, limit: probed.limit ?? null,
        used: probed.used ?? null, renewsAt: probed.renewsAt ?? null,
        asOf: typeof probed.asOf === "number" ? probed.asOf : nowSec };
      changed = true;
    }
  } else if (keyed && probed?.nobonus) {
    next[keyed] = { nobonus: true, asOf: nowSec };
    changed = true;
  }
  const credits = {};
  for (const [email, e] of Object.entries(next)) {
    if (!e || typeof e !== "object") continue;
    credits[email] = { ...e, stale: email !== liveLogin };
  }
  return { map: next, credits, changed };
}

export function saveLastGood(value, lastPath = LAST_PATH) {
  try {
    writeFileSync(lastPath, JSON.stringify({ at: Date.now(), value }));
  } catch { /* tmp non scrivibile: niente stantio, nessun danno */ }
}

export function loadLastGood(lastPath = LAST_PATH, now = Date.now()) {
  try {
    const m = JSON.parse(readFileSync(lastPath, "utf8"));
    if (!m || typeof m.at !== "number" || now - m.at > LAST_TTL_MS) return null;
    if (!m.value || typeof m.value.remaining !== "number") return null;
    return { ...m.value, stale: true, asOf: Math.floor(m.at / 1000) };
  } catch {
    return null;
  }
}

// Il bonus è di chi l'ha riscosso (lastGood): se il login corrente è un
// altro e il live fallisce, non mostrargli una riga "in aggiornamento"
// per un bonus che non ha — si nasconde e basta.
function ownedByOther(login, lastPath) {
  if (!login) return false;
  const last = loadLastGood(lastPath);
  return !!(last?.account && last.account !== login);
}

// Un giro per ogni profilo Max: senza vdm, un giro solo sul login corrente.
// In sequenza: un 429 strozza tutti insieme.
export async function probeCloudCredits(targets) {
  const list = targets.length ? targets : [{ name: null, email: creditAccount() }];
  const out = [];
  for (const t of list) {
    const item = await probeOne(t.name, t.email);
    if (item) out.push(item);
  }
  return out;
}

async function probeOne(name, email) {
  const bin = path.join(os.homedir(), "bin", "credito-cloud");
  if (!existsSync(bin)) return null; // tool assente: sezione nascosta
  if (isFresh(tag(FRESH_PATH, name), FRESH_MS)) {
    const lg = loadLastGood(tag(LAST_PATH, name)); // saldo di pochi minuti fa, con età
    if (lg) return lg;
  }
  if (email && nobonusQuiet(email, tag(NOBONUS_PATH, name))) return { nobonus: true, account: email };
  if (liveQuiet(tag(QUIET_PATH, name))) {
    return ownedByOther(email, tag(LAST_PATH, name)) ? null : { unavailable: true, account: email };
  }
  const env = name ? { ...process.env, CLOUD_ACCOUNT: name } : process.env;
  const res = await new Promise((resolve) => {
    execFile(bin, ["--json"], { timeout: 25000, env }, (err, stdout, stderr) => {
      resolve(err ? { err, stdout, stderr } : { err: null, stdout, stderr });
    });
  });
  // Attribuzione pre-fetch: il token letto dal tool è di questo account
  // anche se vdm ruota in questi millisecondi (si corregge al poll).
  if (res.err) {
    mark(tag(QUIET_PATH, name));
    if (ownedByOther(email, tag(LAST_PATH, name))) return null;
    return { unavailable: true, account: email,
             reason: reasonForFailure(res.err, res.stdout, res.stderr) };
  }
  const c = classifyCreditOutput(res.stdout);
  if (c.kind === "live") {
    mark(tag(FRESH_PATH, name));
    const item = { ...c.value, account: email };
    saveLastGood(item, tag(LAST_PATH, name));
    return item;
  }
  if (c.kind === "nobonus") {
    if (email) mark(tag(NOBONUS_PATH, name), `${email}|${Date.now()}`);
    return { nobonus: true, account: email };
  }
  mark(tag(QUIET_PATH, name));
  if (ownedByOther(email, tag(LAST_PATH, name))) return null;
  return { unavailable: true, account: email,
           reason: reasonForFailure(null, res.stdout, res.stderr) };
}
