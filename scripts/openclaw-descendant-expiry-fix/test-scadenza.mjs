// Barra della patch openclaw-descendant-expiry-fix (25/10, terzo giro).
// Esegue il codice VERO di una copia patchata di dist/ (link ai file del dist installato, i tre file
// toccati copiati e patchati) sulle righe vere del caso 5b137a57, lette in sola lettura dal registro SQLite
// e riportate alle 19:17 del 24/10:
//   - la lettura: `countPendingDescendantRuns` intera, importata dal modulo della copia;
//   - il gate: `runSubagentAnnounceFlow` vera, importata dal modulo della copia e fermata alla prima
//     chiamata dopo il gate (`isCompletionDeliveryAllowed`), prima di qualunque consegna;
//   - il registro: la riga del rinvio eseguita cosi' com'e', con `params.countPendingDescendantRuns` = la
//     funzione vera della copia.
// Ogni sonda gira in un processo a parte con HOME e stato temporanei: nessun gateway, nessun messaggio,
// nessuna scrittura nel registro vero.
//   node test-scadenza.mjs        exit 0 = verde
// Mutanti (passo 6): ognuno deve far cambiare il COMPORTAMENTO su uno dei due scenari (caso vero, figlio
// del turno stesso). Fuori elenco, perche' equivalente: `params.endedAt` al posto di `startedAt` nel gate
// (G2 della verifica). Esclude dal gate il figlio nato durante il turno, ma il ramo successivo del core
// (figli diretti del run, `wakeOnDescendantSettle`) trattiene comunque la consegna: misurato qui, gate «retryable».
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MARK = "jarvis-patch openclaw-descendant-expiry-fix";
const ANCHORS = {
  registry: "const activeDescendantRuns = Date.now() >= resolveAnnounceDeliveryDeadline(",
  read: "async function countPendingDescendantRuns(rootSessionKey, assertCurrent",
  gate: "await countPendingDescendantRuns(params.childSessionKey, () => {",
};
const fileWith = (dir, needle) => {
  const hits = readdirSync(dir).filter((f) => f.endsWith(".mjs") && readFileSync(path.join(dir, f), "utf8").includes(needle));
  assert.equal(hits.length, 1, `atteso 1 file con ${needle}, trovati ${hits.length}`);
  return hits[0];
};

// ======================= sonda: gira nel processo figlio =======================
if (process.argv[2] === "--probe") {
  const { dist, files, runs, when } = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const importOf = (text, prefix) => text.match(new RegExp(`from "\\./(${prefix}-[^"]+\\.mjs)"`))[1];
  const readText = readFileSync(path.join(dist, files.read), "utf8");
  const mem = await import(path.join(dist, importOf(readText, "subagent-registry-memory")));
  const subagentRuns = Object.values(mem).find((v) => v instanceof Map);
  for (const e of runs) subagentRuns.set(e.runId, e);
  const parent = runs.find((e) => e.runId.startsWith("5b137a57"));
  const root = parent.childSessionKey;
  const out = {};

  // lettura: la funzione intera della copia, chiamata come la chiama il gate (due argomenti) e col terzo
  const read = await import(path.join(dist, files.read));
  const count = Object.values(read).find((v) => typeof v === "function" && v.name === "countPendingDescendantRuns");
  out.readAll = await count(root, () => {}).catch((e) => `errore: ${e.constructor.name}`);

  // registro: le due righe del rinvio (scadenza e conteggio), eseguite cosi' come sono nella copia, con le
  // costanti vere del modulo helpers e la funzione vera della lettura
  const regText = readFileSync(path.join(dist, files.registry), "utf8");
  const lines = regText.split("\n");
  const at = lines.findIndex((l) => l.includes(ANCHORS.registry));
  assert.ok(lines[at - 1].includes("const expiryMs = "), "riga della scadenza non trovata sopra il rinvio");
  const fn = (name) => regText.slice(regText.indexOf(`function ${name}(`), regText.indexOf("\n}\n", regText.indexOf(`function ${name}(`)) + 2);
  const helpers = await import(path.join(dist, importOf(regText, "subagent-registry-helpers")));
  const helpersText = readFileSync(path.join(dist, importOf(regText, "subagent-registry-helpers")), "utf8");
  const exported = (name) => helpers[helpersText.match(new RegExp(`${name} as (\\w+)[,}\\s]`))[1]];
  const registryLine = new Function("entry", "params", "assertCurrent", "ANNOUNCE_COMPLETION_HARD_EXPIRY_MS", "ANNOUNCE_EXPIRY_MS",
    `${fn("resolveAnnounceDeliveryDeadline")}\nreturn (async () => { ${lines[at - 1].trim()}\n${lines[at].trim()}\nreturn activeDescendantRuns; })();`);
  try {
    out.registry = await registryLine(parent, { countPendingDescendantRuns: count }, () => {},
      exported("ANNOUNCE_COMPLETION_HARD_EXPIRY_MS"), exported("ANNOUNCE_EXPIRY_MS"));
  } catch (e) {
    out.registry = `errore: ${e.constructor.name}`;
  }

  // gate: runSubagentAnnounceFlow vera, fermata alla prima chiamata dopo il gate
  const announce = await import(path.join(dist, files.gate));
  const flow = Object.values(announce).find((v) => typeof v === "function" && v.name === "runSubagentAnnounceFlow");
  let passedGate = false;
  const STOP = new Error("fermo dopo il gate");
  const outcome = await flow({
    ...parent.delivery.payload,
    requesterAgentId: "main",
    childAgentId: "main",
    timeoutMs: 1000,
    cleanup: "keep",
    suppressChildSessionEffects: false,
    isChildSessionEffectsAllowed: () => true,
    prepareChildSessionEffects: async () => true,
    isCompletionDeliveryAllowed: () => { passedGate = true; throw STOP; },
    isCompletionOwnedByRequesterYield: () => false,
  }).catch((e) => (e === STOP ? "fermato" : `errore: ${e.message}`));
  out.gate = { passedGate, outcome };
  writeFileSync(process.argv[4], JSON.stringify(out));
  process.exit(0);
}

// ======================= orchestratore =======================
const here = path.dirname(new URL(import.meta.url).pathname);
const patch = path.join(here, "openclaw-descendant-expiry-fix.py");
const oc = execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim();
const realDist = path.join(path.dirname(execFileSync("realpath", [oc], { encoding: "utf8" }).trim()), "dist");
const db = path.join(os.homedir(), ".openclaw/state/openclaw.sqlite");
const FILES = Object.fromEntries(Object.entries(ANCHORS).map(([k, a]) => [k, fileWith(realDist, a)]));

const tmp = mkdtempSync(path.join(os.tmpdir(), "oc-expiry-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const dist = path.join(tmp, "dist");
mkdirSync(dist);
for (const f of readdirSync(realDist)) symlinkSync(path.join(realDist, f), path.join(dist, f));
const fresh = () => {
  for (const f of Object.values(FILES)) { rmSync(path.join(dist, f), { force: true }); copyFileSync(path.join(realDist, f), path.join(dist, f)); }
};
const src = (k) => readFileSync(path.join(dist, FILES[k]), "utf8");
const run = (cmd) => {
  try {
    execFileSync("python3", [patch, cmd], { env: { ...process.env, OPENCLAW_DIST: dist }, stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status;
  }
};

// ---- il caso vero ----
const sql = (q) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, q], { encoding: "utf8" }) || "[]");
const rows = sql("select payload_json from subagent_runs where run_id like '5b137a57%' or requester_session_key = 'agent:main:subagent:10047b23-f9f7-4358-a7e0-bfdf2ebaae56'");
assert.ok(rows.length >= 3, `righe del caso nel registro: ${rows.length}`);
const raw = rows.map((r) => { const p = JSON.parse(r.payload_json); return p.parentCompletion ?? p; });
const parentRaw = raw.find((e) => e.runId.startsWith("5b137a57"));
const at = (hh, mm, ss) => new Date(2026, 9, 24, hh, mm, ss).getTime();
// Il registro all'istante `when`, spostato perche' `when` sia l'adesso della sonda: le righe nate dopo non
// ci sono, un run finito dopo e' in corso, ogni istante di primo livello successivo non e' ancora avvenuto.
const snapshot = (when, extra = []) => {
  const shift = Date.now() + 2000 - when; // la sonda parte ~2 s dopo
  const out = [];
  for (const e0 of [...raw, ...extra]) {
    if (e0.createdAt > when) continue;
    const e = structuredClone(e0);
    for (const k of Object.keys(e)) {
      if (!k.endsWith("At") || typeof e[k] !== "number") continue;
      if (e0[k] <= when) e[k] += shift; else delete e[k];
    }
    const x = e.execution ?? {};
    if (typeof x.startedAt === "number") x.startedAt += shift;
    if (typeof x.endedAt === "number" && e0.execution.endedAt <= when) {
      x.endedAt += shift;
      if (x.outcome) for (const k of ["startedAt", "endedAt"]) if (typeof x.outcome[k] === "number") x.outcome[k] += shift;
    } else { x.status = "running"; delete x.endedAt; delete x.outcome; }
    if (e.runId === parentRaw.runId) {
      // alle 19:17 la consegna era in attesa e senza tentativi: il resto (sospesa alle 19:47) viene dopo
      const payload = structuredClone(e.delivery.payload);
      for (const k of ["startedAt", "endedAt"]) if (typeof payload[k] === "number") payload[k] += shift;
      e.delivery = { status: "pending", payload };
    }
    out.push(e);
  }
  return { runs: out, when: when + shift };
};
const probe = (when, extra) => {
  const { runs, when: shifted } = snapshot(when, extra);
  const input = path.join(tmp, "in.json");
  const output = path.join(tmp, "out.json");
  writeFileSync(input, JSON.stringify({ dist, files: FILES, runs, when: shifted }));
  const home = mkdtempSync(path.join(tmp, "home-"));
  execFileSync(process.execPath, [new URL(import.meta.url).pathname, "--probe", input, output], {
    env: { PATH: process.env.PATH, HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state"), TMPDIR: tmp },
    stdio: "pipe", timeout: 90000,
  });
  return JSON.parse(readFileSync(output, "utf8"));
};
const T1917 = at(19, 17, 0);
const ownChild = {
  runId: "figlio-del-turno-2", childSessionKey: "agent:main:subagent:figlio-turno-2",
  requesterSessionKey: parentRaw.childSessionKey, controllerSessionKey: parentRaw.childSessionKey,
  createdAt: parentRaw.execution.startedAt + 2000,
  execution: { status: "running", startedAt: parentRaw.execution.startedAt + 2000 },
};
// lo stato voluto: caso vero -> nessuna attesa e il gate passa; figlio del turno -> attesa e gate fermo
const expectFixed = (label) => {
  const real = probe(T1917);
  const own = probe(T1917, [ownChild]);
  const bad = [];
  if (real.registry !== 0) bad.push(`registro sul caso vero ${real.registry} (atteso 0)`);
  if (!real.gate.passedGate) bad.push(`gate sul caso vero fermo (${real.gate.outcome})`);
  if (own.registry !== 1) bad.push(`registro col figlio del turno ${own.registry} (atteso 1)`);
  if (own.gate.passedGate) bad.push("gate col figlio del turno passato (atteso fermo)");
  return { real, own, bad, label };
};

// 1. check/apply/revert sulla copia dei tre file
fresh();
assert.equal(run("check"), 1, "check prima di apply deve uscire 1");
assert.equal(run("apply"), 0, "apply");
assert.equal(run("apply"), 0, "apply ripetuto (idempotente)");
assert.equal(run("check"), 0, "check dopo apply deve uscire 0");
for (const k of Object.keys(FILES)) assert.ok(src(k).includes(MARK), `${k}: patch mancante dopo apply`);
assert.equal(run("revert"), 0, "revert");
assert.equal(run("check"), 1, "check dopo revert deve uscire 1");
for (const k of Object.keys(FILES)) assert.equal(src(k), readFileSync(path.join(realDist, FILES[k]), "utf8"), `${k}: revert non torna all'originale`);
console.log("ok 1  check: 1 prima, 0 dopo apply, 1 dopo revert; revert byte per byte sui 3 file");

// 2. senza patch, caso vero: il registro rimanda e il gate risponde «retryable» (la sospensione del 24/10)
fresh();
let p = probe(T1917);
assert.ok(p.registry >= 2, `registro senza patch: ${p.registry}`);
assert.equal(p.gate.passedGate, false, "gate senza patch: atteso fermo");
assert.equal(p.gate.outcome, "retryable");
console.log(`ok 2  senza patch (5b137a57 vero): registro ${p.registry}, lettura ${p.readAll}, gate «${p.gate.outcome}»`);

// 3-4. con patch: caso vero consegnato subito, figlio del turno stesso ancora atteso
run("apply");
const fixed = expectFixed("patch");
assert.deepEqual(fixed.bad, [], fixed.bad.join("; "));
console.log("ok 3  con patch (5b137a57 vero): registro 0, gate passato -> consegna tentata alle 19:17");
console.log("ok 4  con patch: figlio del turno stesso -> registro 1, gate «retryable»");

// 5. la copia patchata resta JavaScript valido
for (const f of Object.values(FILES)) execFileSync("node", ["--check", path.join(dist, f)]);
console.log("ok 5  node --check sui tre file patchati");

// 6. mutanti: ognuno rompe il comportamento su almeno uno dei due scenari
const MUTANTS = {
  M1: ["registry", ", entry.execution?.startedAt ?? entry.createdAt);", ");"],
  M2: ["registry", "entry.execution?.startedAt ?? entry.createdAt", "entry.createdAt"],
  M3: ["read", "dropChildrenSpawnedBefore(new Map(runs), rootSessionKey, spawnedSince)", "new Map(runs)"],
  M4: ["gate", "}, params.startedAt))) > 0) {", "}))) > 0) {"],
  A2: ["registry", "assertCurrent, entry.execution?.startedAt ?? entry.createdAt);", "assertCurrent, void 0, entry.execution?.startedAt ?? entry.createdAt);"],
  A3: ["read", "async function countPendingDescendantRuns(rootSessionKey, assertCurrent, spawnedSince) {", "async function countPendingDescendantRuns(rootSessionKey, assertCurrent) {"],
  G4: ["gate", "}, params.startedAt))) > 0) {", "}, void 0, params.startedAt))) > 0) {"],
};
for (const [name, [k, from, to]] of Object.entries(MUTANTS)) {
  fresh(); run("apply");
  const text = src(k);
  assert.equal(text.split(from).length - 1, 1, `${name}: punto di mutazione non trovato`);
  writeFileSync(path.join(dist, FILES[k]), text.replace(from, to));
  const m = expectFixed(name);
  assert.ok(m.bad.length > 0, `${name} sopravvive`);
  console.log(`ok 6  ${name} rosso: ${m.bad.join("; ")}`);
}
