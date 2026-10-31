#!/usr/bin/env node
// Prova di comportamento del plugin OpenClaw di ai-memory: carica index.ts con un'API finta e un
// server finto, chiama before_prompt_build e conta i POST user-prompt.
//   (a) testo girato fra sessioni con isUser=false     -> nessun POST
//   (b) prompt normale                                 -> POST
//   (c) stesso prefisso con isUser=true                -> POST
//   (d) prefisso con isUser=false solo nel corpo       -> POST (conta la riga d'intestazione)
//   (e) utente che cita il prefisso più avanti         -> POST
//   (f) il contesto (handoff) arriva anche sul testo girato
// Uso: aimem-plugin-test.mjs [percorso/index.ts]   (default: il plugin installato)
// Aspetta i POST fino a 20 s dall'ultimo arrivato (positivi, sentinella, spool vuoto), con un tetto assoluto
// di 5 minuti dopo il quale i controlli restanti sono KO. I negativi si controllano solo alla fine: nessun
// POST user-prompt con il loro sessionID, né in rete né nello spool (un messaggio girato e poi troncato è KO), e
// nessun POST user-prompt di qualunque sessione, o senza sessione, con il loro contrassegno.
// Solo ID finti: nessun ID Discord o WhatsApp vero.
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const installed = join(homedir(), "Library", "Application Support", "ai-memory", "openclaw-plugin");
const source = process.argv[2] || join(installed, "index.ts");

const work = mkdtempSync(join(tmpdir(), "aimem-plugin-test."));
const calls = [];
let handoffBody = "";
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && url.pathname === "/hook") lastProgress = Date.now();
    if (req.method === "POST" && url.pathname === "/hook") calls.push({ event: url.searchParams.get("event"), body });
    if (req.method === "GET" && url.pathname === "/handoff") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(handoffBody);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Copia di lavoro: stesso codice, server finto al posto di quello vero. Dati, spool e token restano nella
// cartella temporanea, nulla tocca la memoria vera.
const pluginDir = join(work, "plugin");
mkdirSync(pluginDir);
writeFileSync(join(pluginDir, "package.json"), '{"type":"module"}\n');
const text = readFileSync(source, "utf8");
if (!text.includes("http://127.0.0.1:49374")) throw new Error("server atteso non trovato nel plugin");
writeFileSync(join(pluginDir, "index.ts"), text.replaceAll("http://127.0.0.1:49374", base));
process.env.AI_MEMORY_DATA_DIR = join(work, "data");
process.env.AI_MEMORY_AUTH_TOKEN = "token-finto";
const repo = join(work, "repo");
mkdirSync(join(repo, ".git"), { recursive: true });

// Il pacchetto di OpenClaw non c'è fuori dal gateway: basta definePluginEntry.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "openclaw/plugin-sdk/plugin-entry") {
      return { url: "data:text/javascript,export const definePluginEntry = (e) => e;", shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const plugin = (await import(join(pluginDir, "index.ts"))).default;

const handlers = {};
plugin.register({
  pluginConfig: { scope: "owner-direct" },
  config: { commands: { ownerAllowFrom: [] } },
  on: (name, fn) => (handlers[name] = fn),
});

const header = (isUser, tool = "sessions_send") =>
  `[Inter-session message] sourceSession=agent:main:channel:fake-1 sourceTool=${tool} isUser=${isUser}`;
const routed = "This content was routed by OpenClaw from another session or internal tool.";
// Ogni caso ha un testo unico (positivi) e un sessionID unico (negativi): si guarda quali POST portano quel
// testo o quella sessione, non quanti ne arrivano. Un POST che scade (500 ms, a Mac carico) va nello spool e
// arriva in ritardo o due volte: il conteggio non è stabile, testo e sessione sì. Per i negativi conta la
// sessione e non il testo, così un plugin che cattura il messaggio girato troncato non passa; ma sessionId è
// facoltativo in OpenClaw, e un POST senza sessione sfuggirebbe: i negativi guardano anche il contrassegno, messo
// subito dopo l'intestazione. Oggi il plugin manda il testo intero; così regge anche una cattura che ne tenesse solo la testa.
const run = Math.random().toString(36).slice(2, 8);
const mark = (id) => `tok${run}${id}`;
const cases = [
  ["a girato isUser=false", (t) => `${header(false)}\n${t}\n${routed}\nbody`, false],
  ["a2 girato subagent isUser=false", (t) => `${header(false, "subagent_settle")}\n${t}\n${routed}`, false],
  ["b prompt normale", (t) => `ciao, controlla il piano di domani ${t}`, true],
  ["c stesso prefisso isUser=true", (t) => `${header(true)}\n${routed}\nbody ${t}`, true],
  ["d isUser=false solo nel corpo", (t) => `${header(true)}\nnel corpo c'è isUser=false ${t}`, true],
  ["e citazione più avanti", (t) => `guarda questo messaggio: ${header(false)} ${t}`, true],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 20000;
// Tetto assoluto: i 20 s ripartono a ogni POST e i richiami sono POST, con uno spool che non si svuota
// l'attesa non finirebbe mai. Scaduto il tetto ogni attesa torna subito e il caso è KO.
const HARD_MS = 5 * 60 * 1000;
const startedAt = Date.now();
// Un POST scaduto va nello spool e riparte solo dopo che un POST successivo è arrivato: come nell'uso vero,
// mentre lo spool non è vuoto continua ad arrivare un prompt normale (richiamo) che lo fa ripartire. I 20 s
// contano dall'ultimo POST arrivato: a Mac molto carico ogni hook del plugin spende secondi in git, e finché
// qualcosa arriva il plugin non è fermo, è lento.
let nudges = 0;
let lastProgress = Date.now();
async function until(cond) {
  lastProgress = Date.now();
  let nextNudge = 0;
  while (Date.now() - lastProgress < WAIT_MS && Date.now() - startedAt < HARD_MS) {
    if (cond()) return true;
    if (spooled().length > 0 && Date.now() >= nextNudge) {
      await handlers.before_prompt_build({ prompt: `prompt di richiamo ${run}n${nudges}` }, ctxFor(`n${nudges++}`));
      nextNudge = Date.now() + 2000;
    }
    await sleep(25);
  }
  return cond();
}
const posts = () => calls.filter((c) => c.event === "user-prompt");
const carries = (t) => posts().filter((c) => c.body.includes(t)).length;
const sessionOf = (body) => {
  try {
    return JSON.parse(body).sessionID;
  } catch (_e) {
    return undefined;
  }
};
const spoolDir = join(work, "data", "hook-spool");
const spooled = () => (existsSync(spoolDir) ? readdirSync(spoolDir).filter((n) => n.endsWith(".json")) : []);
// Corpi dei user-prompt in attesa nello spool. Il drain può cancellare un file fra l'elenco e la lettura: in
// quel caso il POST è già arrivato e sta in calls.
const spoolBodies = () =>
  spooled().flatMap((n) => {
    try {
      const entry = JSON.parse(readFileSync(join(spoolDir, n), "utf8"));
      return new URL(entry.url).searchParams.get("event") === "user-prompt" ? [entry.body] : [];
    } catch (_e) {
      return [];
    }
  });
// Quanti POST user-prompt sono arrivati o aspettano nello spool con la sessione del caso (id intero, o prefisso
// per il caso f che ne prova più d'una) oppure, di qualunque sessione o senza, con il suo contrassegno. Prima lo
// spool, poi la rete: un file sparito nel frattempo è già in calls.
const leaked = (sid, t, prefix = false) =>
  [...spoolBodies(), ...posts().map((c) => c.body)].filter((b) => {
    const s = sessionOf(b);
    return (typeof s === "string" && (prefix ? s.startsWith(sid) : s === sid)) || b.includes(t);
  }).length;

let bad = 0;
const report = (okCase, line) => {
  if (!okCase) bad++;
  console.log(`${okCase ? "ok  " : "KO  "} ${line}`);
};
const negatives = [];
const ctxFor = (id) => ({ sessionKey: "agent:main:main", sessionId: `finto-${run}-${id}`, workspaceDir: repo });
const positives = [];
for (const [i, [name, build, want]] of cases.entries()) {
  const t = mark(i);
  await handlers.before_prompt_build({ prompt: build(t) }, ctxFor(i));
  if (want) positives.push([name, t]);
  else negatives.push([name, () => leaked(ctxFor(i).sessionId, t)]);
}

// (f) il filtro tocca solo la cattura: il contesto da iniettare arriva comunque. Il contesto ha una richiesta
// con scadenza di 1 s: a Mac carico può mancare, quindi si riprova con una sessione nuova (il piano è per sessione).
handoffBody = "CONTESTO-FINTO";
const tf = mark("f");
let out;
for (let k = 0; k < 5 && out?.prependContext !== "CONTESTO-FINTO"; k++) {
  out = await handlers.before_prompt_build({ prompt: `${header(false)}\n${tf}\n${routed}` }, ctxFor(`f${k}`));
}
negatives.push(["f girato con contesto", () => leaked(ctxFor("f").sessionId, tf, true)]);

// Positivi: il POST deve arrivare, anche in ritardo.
for (const [name, t] of positives) {
  const got = await until(() => carries(t) > 0);
  report(got, `${name}: POST con il testo del caso ${got ? "arrivato" : `non arrivato in ${WAIT_MS / 1000} s`}`);
}

// Sentinella: un prompt normale in coda. Quando è arrivata e lo spool è vuoto, i POST dei casi negativi
// (partiti prima) sarebbero già arrivati: solo ora si controlla che non ne esista nessuno.
const ts = mark("sentinel");
await handlers.before_prompt_build({ prompt: `sentinella ${ts}` }, ctxFor("sentinel"));
const sentinel = await until(() => carries(ts) > 0);
report(sentinel, `sentinella: POST ${sentinel ? "arrivato" : `non arrivato in ${WAIT_MS / 1000} s`}`);
await until(() => spooled().length === 0);
await sleep(500);
for (const [name, count] of negatives) {
  const n = count();
  report(n === 0, `${name}: POST con la sua sessione o il suo contrassegno ${n} (atteso 0)`);
}
const f2 = out?.prependContext === "CONTESTO-FINTO";
report(f2, `f contesto iniettato anche sul girato: prependContext ${f2 ? "sì" : "no"}`);

await new Promise((r) => server.close(r));
rmSync(work, { recursive: true, force: true });
console.log(bad ? `${bad} casi falliti` : "plugin: filtro del testo girato verde");
process.exit(bad ? 1 : 0);
