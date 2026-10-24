// Decide chi esegue un compito delegato: Jev classifica (gusto o meccanico, servono strumenti?),
// il gate del pacing sceglie l'abbonamento. Chi delega non sceglie niente.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gate } from './pacing.mjs';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MAX_CHARS = 500;
// Scelto col banco (bin/route-bench.mjs) fra i modelli decisionali disponibili, non per nome.
export const JEV_MODEL = 'jev-preview'; // 18/10: 95% contro 90% di jev-latest, pari ai canali gratis ma 8x più veloce (288 ms)
// Dati di persone vere: il testo non esce dal Mac, decidono le regole (Attilio 18/10).
const PRIVATE_PROJECT = /lead|mail|crm|fattur/i;
// I nomi dei clienti restano nella configurazione locale, fuori dal codice pubblico.
let cachedPrivateProjects = null;
function privateProjects() {
  if (cachedPrivateProjects !== null) return cachedPrivateProjects;
  const file = process.env.USAGE_HUB_PRIVATE_PROJECTS_FILE
    || path.join(os.homedir(), '.config', 'claude-usage-hub', 'private-projects.json');
  try {
    const values = JSON.parse(fs.readFileSync(file, 'utf8'));
    cachedPrivateProjects = Array.isArray(values)
      ? values.filter((value) => typeof value === 'string' && value.trim())
        .map((value) => new RegExp(value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
      : [];
  } catch {
    cachedPrivateProjects = [];
  }
  return cachedPrivateProjects;
}
const PERSONAL_DATA = /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s]{8,}\d/;
const TASTE_WORDS = /design|logo|animaz|layout|\bui\b|\bux\b|stile|tono|copy|brand|naming|fedel|giudica|bell[oa]|gusto|hero|scrivi (un|una|il|la) (post|mail|articolo|pagina|testo)/i;
const TEXT_ONLY_WORDS = /^(riassumi|traduci|spiega|rispondi|classifica|estrai da questo testo)\b/i;

export function isPrivate(task, project = '') {
  const extraProjects = privateProjects();
  return PRIVATE_PROJECT.test(project) || extraProjects.some((pattern) => pattern.test(project)) || PERSONAL_DATA.test(task);
}

export function classifyByRules(task) {
  return { cls: TASTE_WORDS.test(task) ? 'taste' : 'mechanical', tools: !TEXT_ONLY_WORDS.test(task.trim()), by: 'rules' };
}

let cachedKey = null;
function jevKey() {
  if (cachedKey) return cachedKey;
  try { cachedKey = execFileSync('security', ['find-generic-password', '-s', 'typesafe', '-a', 'jev', '-w'], { encoding: 'utf8' }).trim(); return cachedKey; }
  catch { return ''; }
}

export async function classifyByJev(task, { fetchImpl = fetch, key = jevKey(), timeoutMs = 6000, model = JEV_MODEL } = {}) {
  if (!key) throw new Error('jev: chiave mancante');
  const body = {
    model,
    state: { compito: task.slice(0, JEV_MAX_CHARS) },
    questions: {
      cls: {
        type: 'choice',
        instructions: 'Che tipo di lavoro è questo compito da delegare a un agente?',
        criteria: {
          taste: 'Conta la qualità percepita da una persona: design, interfacce, logo, animazioni, testi da leggere, naming, giudicare se qualcosa è bello o fedele a un riferimento',
          mechanical: 'Lavoro meccanico verificabile: cercare, leggere, estrarre, riassumere, refactor, codice ripetitivo, test, conteggi, configurazione',
        },
      },
      tools: { type: 'noul', instructions: 'Per farlo bisogna leggere o scrivere file, lanciare comandi o navigare, invece di rispondere solo a parole?' },
    },
  };
  const r = await fetchImpl(JEV_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`jev: HTTP ${r.status}`);
  const d = await r.json();
  const a = d.answers || {};
  const cls = a.cls?.choice;
  const t = a.tools || {};
  const tools = t.probability ?? t.noul ?? t.answer;
  if (cls !== 'taste' && cls !== 'mechanical') throw new Error('jev: risposta senza classe');
  return { cls, tools: typeof tools === 'number' ? tools >= 0.5 : tools !== false, by: 'jev' };
}

// Classe di lavoro → classe del gate. Senza strumenti il meccanico può andare sui canali gratis.
// Decisore su endpoint OpenAI-compatibile (Groq): stessa domanda di Jev, risposta JSON.
export const LLM_DECIDER = { base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keychain: 'groq' };
let cachedLlmKey = null;
function llmKey() {
  if (cachedLlmKey) return cachedLlmKey;
  try { cachedLlmKey = execFileSync('security', ['find-generic-password', '-s', LLM_DECIDER.keychain, '-a', 'api-key', '-w'], { encoding: 'utf8' }).trim(); return cachedLlmKey; }
  catch { return ''; }
}
const LLM_SYSTEM = 'Classify a task that will be delegated to an AI agent. Reply ONLY with JSON {"class":"taste"|"mechanical","tools":true|false}. taste = perceived quality matters: design, UI, logo, animation, copy written for people, naming, judging whether something is beautiful or faithful to a reference. mechanical = verifiable work: search, read, extract, summarize, refactor, repetitive code, tests, configuration, deploy. tools = the agent must read or write files, run commands or browse; false only if answering in words about the given text is enough.';
export async function classifyByLLM(task, { fetchImpl = fetch, key = llmKey(), timeoutMs = 6000, base = LLM_DECIDER.base, model = LLM_DECIDER.model } = {}) {
  if (!key) throw new Error('llm: chiave mancante');
  const r = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, max_tokens: 400, temperature: 0, reasoning_effort: 'low', response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: LLM_SYSTEM }, { role: 'user', content: task.slice(0, JEV_MAX_CHARS * 4) }] }),
  });
  if (!r.ok) throw new Error(`llm: HTTP ${r.status}`);
  const out = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
  if (out.class !== 'taste' && out.class !== 'mechanical') throw new Error('llm: risposta senza classe');
  return { cls: out.class, tools: out.tools !== false, by: model.split('/').pop() };
}

// projectInfo = riga di /api/live (budget e priorità del progetto), se c'è.
// Catena misurata col banco del 18/10: Groq gpt-oss-120b (100%, ~470 ms, tetto 8k token/min sul gratuito)
// → jev-preview (95%, ~290 ms, nessun tetto visto) → regole (85%). Il primo che risponde decide.
export async function classifyChain(task) {
  try { return await classifyByLLM(task); }
  catch (e1) {
    try { return { ...(await classifyByJev(task)), by: `jev (${e1.message})` }; }
    catch (e2) { throw new Error(`${e1.message}; ${e2.message}`); }
  }
}

export const CLAUDE_MODEL_ID = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

// Quale modello Claude per un compito che va su Claude. Il gusto parte da Opus quando Claude ha margine per quel progetto:
// il gate è passato e il ritmo dell'account è ≤ 1, oppure il progetto ha priorità alta (corre di più per scelta di Attilio).
// Frenato (ritmo > 1 su priorità normale o bassa) o in riserva → Sonnet.
// Il meccanico va su Haiku 5.5 (24/10, Attilio: «su Claude hai anche Haiku»): accetta l'effort e costa circa un
// ventesimo di Sonnet (tools/effort.md, misura del 23/10). Effort medium con strumenti (refactor, test), low senza.
export function modelFor(g, cls, rows, projectInfo, tools = true) {
  if (!g.go) return { model: null, modelReason: '' };
  if (g.provider !== 'claude') return { model: g.provider, modelReason: '' };
  if (cls !== 'taste') return { model: 'haiku', effort: tools ? 'medium' : 'low', modelReason: `lavoro meccanico: Haiku a effort ${tools ? 'medium' : 'low'} (un ventesimo di Sonnet)` };
  const row = rows.find((r) => r.provider === 'claude' && r.account === g.account);
  const pace = row && row.pace != null ? row.pace : 0;
  const priority = (projectInfo && projectInfo.priority) || 'normale';
  if (pace <= 1) return { model: 'opus', modelReason: `gusto con margine: ritmo Claude ${String(pace).replace('.', ',')} (≤ 1)` };
  if (priority === 'alta') return { model: 'opus', modelReason: `gusto su progetto a priorità alta: Opus anche con ritmo ${String(pace).replace('.', ',')}` };
  return { model: 'sonnet', modelReason: `gusto ma Claude frenato: ritmo ${String(pace).replace('.', ',')} > 1, priorità ${priority}` };
}

export async function route(rows, task, { project = '', projectInfo = null, classify = classifyChain, cls: forced = null, overrides = [] } = {}) {
  let c;
  if (forced) c = { cls: forced, tools: true, by: 'forced' };
  else if (isPrivate(task, project)) c = { ...classifyByRules(task), by: 'rules (dati personali)' };
  else {
    try { c = await classify(task); }
    catch (e) { c = { ...classifyByRules(task), by: `rules (${e.message})` }; }
  }
  const gateClass = c.cls === 'taste' ? 'gusto' : 'massivo';
  // Dati di persone vere: niente canali gratis (escono verso terzi). Muse sì: Attilio 22/10, «non c'è bisogno di non mettere cose su Muse».
  const priv = isPrivate(task, project);
  const skip = priv || c.tools ? ['free'] : [];
  // Gli override valgono anche qui: prima del 22/10 li vedevano solo la tray e il comando, la delega no.
  const g = gate(rows, gateClass, { project: projectInfo, skip, overrides });
  return { ...g, ...modelFor(g, c.cls, rows, projectInfo, c.tools), cls: c.cls, tools: c.tools, by: c.by, gateClass };
}
