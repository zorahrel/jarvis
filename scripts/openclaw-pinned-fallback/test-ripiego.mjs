// Barra del ripiego silenzioso (24/10). Simula il caso delle 02:30: chat WhatsApp con Opus fissato a
// mano, Opus risponde 529 Overloaded. Usa il codice vero di OpenClaw su disco (dist/ patchato) e il
// plugin errori-italiano vero; nessuna chiamata a modelli, nessun messaggio inviato.
//   node test-ripiego.mjs        exit 0 = verde
// Mutazione: openclaw-pinned-fallback.py revert -> il passo 1 diventa rosso (catena spenta).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const oc = execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim();
const dist = process.env.OPENCLAW_DIST || path.join(path.dirname(execFileSync("realpath", [oc], { encoding: "utf8" }).trim()), "dist");
const find = (needle) => {
  const hits = readdirSync(dist).filter((f) => f.endsWith(".mjs") && readFileSync(path.join(dist, f), "utf8").includes(needle));
  assert.equal(hits.length, 1, `atteso 1 file con ${needle}, trovati ${hits.length}`);
  return path.join(dist, hits[0]);
};
const named = async (file, fnName) => {
  const mod = await import(file);
  const fn = Object.values(mod).find((v) => typeof v === "function" && v.name === fnName);
  assert.ok(fn, `${fnName} non esportata da ${path.basename(file)}`);
  return fn;
};

const cfg = JSON.parse(readFileSync(path.join(os.homedir(), ".openclaw/openclaw.json"), "utf8"));
const SESSION = "agent:main:whatsapp:direct:+390000000000";

// 1. modello fissato a mano: la catena dell'agente resta accesa
const scope = find("function resolveModelFallbackAvailability(params) {");
const availability = await named(scope, "resolveModelFallbackAvailability");
const toOverride = await named(scope, "modelFallbackOverrideFromAvailability");
const av = availability({ cfg, agentId: "main", sessionKey: SESSION, hasSessionModelOverride: true, modelOverrideSource: "user" });
assert.equal(av.kind, "active", `catena con modello fissato: ${av.kind} (atteso active)`);
const fallbacks = toOverride(av);
assert.deepEqual(fallbacks, cfg.agents.entries.main.model.fallbacks);
console.log(`ok 1  modello fissato -> catena attiva: ${fallbacks.join(" -> ")}`);

// 2. Opus 529 -> il turno ripete sul modello dopo, senza errore
const runner = find("async function runWithModelFallback(params) {");
const runWithModelFallback = await named(runner, "runWithModelFallback");
const FailoverError = (await import(find("var FailoverError = class extends Error {"))).n;
const calls = [];
const result = await runWithModelFallback({
  cfg,
  agentId: "main",
  provider: "anthropic",
  model: "claude-opus-5-5",
  fallbacksOverride: fallbacks,
  skipAuthProfileRuntime: true,
  // fuori dal gateway il motore Codex non e' registrato: ogni candidato gira sul runtime base
  resolveAgentHarnessRuntimeOverride: () => "openclaw",
  run: async (provider, model) => {
    calls.push(`${provider}/${model}`);
    if (calls.length === 1) {
      throw new FailoverError("API Error: 529 Overloaded. This is a server-side issue, usually temporary", {
        reason: "overloaded", provider, model, status: 529,
      });
    }
    return { text: "risposta", provider, model };
  },
});
assert.equal(calls[0], "anthropic/claude-opus-5-5");
assert.equal(calls.length, 2, `tentativi: ${calls.join(", ")}`);
assert.equal(calls[1], fallbacks[0]);
assert.ok(JSON.stringify(result).includes('"risposta"'), `esito senza la risposta: ${JSON.stringify(result).slice(0, 200)}`);
console.log(`ok 2  529 su Opus -> ripetuto su ${calls[1]}, risposta arrivata`);

// 3. nessun avviso del ripiego in chat
const runnerRun = find("const shouldDeliverFallbackNotice = ");
assert.match(readFileSync(runnerRun, "utf8"), /const shouldDeliverFallbackNotice = false;/);
console.log("ok 3  avviso «↪️ Model Fallback» spento nel codice");

// 4. plugin: l'avviso, se passasse, viene taciuto; la catena caduta diventa una riga italiana + nuovo tentativo
const P = mkdtempSync(path.join(os.tmpdir(), "errori-it-"));
cpSync(path.join(os.homedir(), "Projects/openclaw-errori-italiano"), path.join(P, "p"), { recursive: true, filter: (s) => !/\/(node_modules|\.git)(\/|$)/.test(s) });
const sdk = path.join(P, "p", "node_modules", "openclaw", "plugin-sdk");
mkdirSync(sdk, { recursive: true });
writeFileSync(path.join(P, "p/node_modules/openclaw/package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: { "./plugin-sdk/plugin-entry": "./plugin-sdk/plugin-entry.js" } }));
writeFileSync(path.join(sdk, "plugin-entry.js"), "export const definePluginEntry = (e) => e;\n");
process.env.HOME = P; // lo stato del plugin va nella cartella di prova
const { makeHandler } = await import(path.join(P, "p", "index.js"));
const store = {};
const retries = [];
let t = 1_800_000_000_000;
const h = makeHandler({ now: () => t, retry: (k, m) => retries.push([k, m]), state: { load: () => store, save: () => {} } });
const ctx = { channelId: "whatsapp", sessionKey: SESSION };
const notice = h({ content: "↪️ Model Fallback: openai/gpt-6-luna (selected anthropic/claude-opus-5-5; overloaded)" }, ctx);
assert.equal(notice?.cancel, true);
const english = "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";
const out = h({ content: english }, ctx);
assert.equal(out.content, "❌ Non riesco a rispondere: modelli giù, riprovo tra 2 min.");
assert.deepEqual(retries, [[SESSION, 2]]);
assert.equal(h({ content: english }, ctx)?.cancel, true, "secondo errore dello stesso turno: taciuto");
t += 3 * 60_000;
assert.match(h({ content: english }, ctx).content, /riprovo tra 5 min/);
assert.equal(h({ content: "Ecco il riepilogo di oggi." }, ctx), undefined, "un messaggio normale passa intatto");
assert.equal(store[SESSION], undefined, "e azzera il conto dei tentativi");
console.log("ok 4  plugin: avviso taciuto; errore -> «❌ Non riesco a rispondere: modelli giù, riprovo tra 2 min.» + nuovo turno in 2 min");
console.log("VERDE");
