// Dati inventati per le fixture del modello: nomi di prova, nessun nome vero.
// Genera model-ok.json e model-problemi.json con buildModel vero, così restano coerenti.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fp } from '../../../src/automations/describe.mjs';
import { buildState } from '../../../src/automations/feedback.mjs';
import { buildModel } from '../../../src/automations/model.mjs';

export const NOW = 1792764000000; // ven 23/10/2026, ore 16 Roma
const MIN = 60000;
const H = 3600000;
const DAY = 24 * H;
const SUN = Date.parse('2026-10-18T03:19:00+02:00'); // domenica alle 3:19
const iso = (ms) => new Date(ms).toISOString();

const item = (over) => ({
  enabled: true, everyMs: null, next: null, nextApprox: false, expectedLast: null,
  last: { at: null, outcome: null, delivered: null, error: null },
  runs: [], consecutiveErrors: 0, runsToday: 0,
  who: 'Claude', reportsTo: 'nessun messaggio',
  tech: { schedule: null, exit: null, command: null, prompt: null, label: null, url: null },
  ...over,
});
const okAt = (at) => ({ at, outcome: 'ok' });
const errAt = (at) => ({ at, outcome: 'error' });
const desc = (titolo, cosa, tiScrive, group, extra = {}) => ({ titolo, cosa, tiScrive, group, ...extra });
const fpFor = (d, it) => fp(`${d?.cosa || ''}|${d?.tiScrive || ''}|${it.tech?.prompt || it.tech?.command || ''}`);
const voteRow = (key, d, it, id) => ({ id, key, kind: 'vote', v: 'ok', fp: fpFor(d, it), note: null, at: iso(NOW - 3 * DAY), by: 'operatore', src: 'hub' });

// Raccoglie item, descrizioni e righe feedback, poi chiama buildModel.
function assemble({ items, descriptions, rows = [], wfItems = [], runs = [], sourceOver = {}, modelOver = {} }) {
  const src = (list, over = {}) => ({ ok: true, at: NOW - 60000, items: list, ...over });
  const sources = {
    openclaw: src(items.filter((i) => i.provider === 'openclaw'), sourceOver.openclaw),
    launchd: src(items.filter((i) => i.provider === 'launchd'), sourceOver.launchd),
    desktop: src(items.filter((i) => i.provider === 'desktop'), sourceOver.desktop),
    workflows: { ok: true, at: NOW - 60000, items: wfItems, runs, ...sourceOver.workflows },
    github: src(items.filter((i) => i.provider === 'github'), sourceOver.github),
    pc: src(items.filter((i) => i.provider === 'pc'), sourceOver.pc),
    counted: { ok: true, at: NOW - 60000, counts: { codex: 2, jcode: 0, topics: null } },
  };
  return buildModel({
    now: NOW,
    sources,
    descriptions,
    feedback: buildState(rows, { now: NOW }),
    findings: { at: NOW - H, items: [] },
    gateway: { up: true },
    proofs: {},
    ...modelOver,
  });
}

// Tutto sano: 20 card va, 5 mai votate, PC che dorme.
export function buildOk() {
  const D = {
    'cron:posta-veloce': desc('Avviso mail importanti', 'Legge la posta ogni minuto e avvisa se c’è qualcosa di urgente.', 'Ti scrive su WhatsApp solo quando serve.', 'arriva'),
    'cron:posta-sera': desc('Riepilogo serale dei messaggi', 'Raccoglie i messaggi della giornata in un unico riepilogo.', 'Ti scrive su WhatsApp la sera.', 'arriva'),
    'launchd:com.prova.sera': desc('Promemoria della sera', 'Ricorda le cose rimaste in sospeso prima di cena.', 'Ti scrive su WhatsApp.', 'arriva'),
    'cron:avvisi-tele': desc('Avvisi urgenti in chat', 'Controlla i canali urgenti e avvisa subito.', 'Ti scrive su Telegram.', 'arriva'),
    'desktop:promemoria-festa': desc('Promemoria festa di prova', 'Ricorda di preparare la festa di prova di domani.', 'Ti scrive la sessione che lo ha creato.', 'arriva'),
    'cron:backup-notte': desc('Backup notturno nel repo privato', 'Copia i dati della giornata nel repo privato di notte.', 'Nessun messaggio se va tutto bene.', 'dati'),
    'launchd:com.prova.ore': desc('Copia di sicurezza ogni sei ore', 'Fa una copia di sicurezza a intervalli regolari.', 'Nessun messaggio.', 'dati'),
    'cron:pulizia-scratch': desc('Pulizia settimanale dei file temporanei', 'Butta i file temporanei vecchi di una settimana.', 'Nessun messaggio.', 'dati'),
    'gh:prova/foto/.github/workflows/foto.yml': desc('Archivio foto verificato', 'Controlla ogni giorno che l’archivio foto sia integro.', 'Lo vedi su GitHub.', 'dati'),
    'cron:quote-muse': desc('Livello delle quote IA', 'Controlla quanto hai usato del modello principale.', 'Nessun messaggio.', 'quote'),
    'cron:quote-codex': desc('Quote del secondo modello', 'Controlla quanto hai usato del secondo modello.', 'Nessun messaggio.', 'quote'),
    'launchd:com.prova.residui': desc('Controllo dei residui di quota', 'Verifica i residui di quota dal Mac.', 'Nessun messaggio.', 'quote'),
    'cron:battito': desc('Battito del sistema', 'Verifica ogni cinque minuti che il sistema risponda.', 'Ti scrive in chat solo se c’è qualcosa.', 'macchine'),
    'launchd:com.prova.dischi': desc('Sorveglianza dei dischi', 'Controlla lo spazio libero sui dischi.', 'Nessun messaggio.', 'macchine'),
    'cron:rete-casa': desc('Controllo della rete di casa', 'Verifica ogni ora che la rete di casa risponda.', 'Nessun messaggio.', 'macchine'),
    'gh:prova/rete/.github/workflows/lint.yml': desc('Controllo automatico del codice', 'Esegue il controllo del codice a ogni giro.', 'Lo vedi su GitHub.', 'macchine'),
    'cron:pulizia-log': desc('Rotazione dei log di sistema', 'Ruota i log di sistema una volta a settimana.', 'Nessun messaggio.', 'macchine'),
    'cron:collaudo-rapido': desc('Collaudo completo del prodotto', 'Esegue ogni giorno il collaudo completo del prodotto.', 'Lo vedi su GitHub.', 'prodotti'),
    'gh:prova/app/.github/workflows/collaudo.yml': desc('Collaudo settimanale del prodotto', 'Esegue il collaudo lungo una volta a settimana.', 'Lo vedi su GitHub.', 'prodotti'),
    'cron:verifica-prezzi': desc('Verifica dei prezzi pubblicati', 'Controlla ogni giorno che i prezzi pubblicati siano giusti.', 'Nessun messaggio.', 'prodotti'),
  };
  const I = [
    item({ key: 'cron:posta-veloce', provider: 'openclaw', name: 'posta-veloce', everyMs: MIN, when: 'ogni minuto', next: NOW + 30000, last: { at: NOW - 30000, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 30000), okAt(NOW - 90000), okAt(NOW - 150000)], consecutiveErrors: 0, runsToday: 240, who: 'script: posta.py', reportsTo: 'WhatsApp', tech: { schedule: 'ogni minuto', exit: null, command: 'posta.py --controlla', prompt: null, label: 'posta-veloce', url: null } }),
    item({ key: 'cron:posta-sera', provider: 'openclaw', name: 'posta-sera', everyMs: H, when: 'ogni ora', last: { at: NOW - 20 * MIN, outcome: 'ok', delivered: 'delivered', error: null }, runs: [okAt(NOW - 20 * MIN)], runsToday: 12, who: 'Claude', reportsTo: 'WhatsApp' }),
    item({ key: 'launchd:com.prova.sera', provider: 'launchd', name: 'com.prova.sera', everyMs: DAY, when: 'ogni giorno alle 20:00', next: NOW + 4 * H, expectedLast: NOW - 20 * H, last: { at: NOW - 20 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 20 * H)], runsToday: 1, who: 'Claude', reportsTo: 'nessun messaggio' }),
    item({ key: 'cron:avvisi-tele', provider: 'openclaw', name: 'avvisi-tele', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - 3 * H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 3 * H)], runsToday: 1, who: 'Claude', reportsTo: 'Telegram' }),
    item({ key: 'desktop:promemoria-festa', provider: 'desktop', name: 'Promemoria festa di prova', everyMs: null, when: 'oggi alle 21:00', next: NOW + 5 * H, last: { at: null, outcome: null, delivered: null, error: null }, runs: [], runsToday: 0, who: 'Claude (app desktop)', reportsTo: "la sessione che l'ha creato", fireAt: NOW + 5 * H, neverRan: true, tech: { schedule: new Date(NOW + 5 * H).toISOString(), exit: null, command: null, prompt: 'Ricorda la festa di prova.', label: 'festa', url: null } }),
    item({ key: 'cron:backup-notte', provider: 'openclaw', name: 'backup-notte', everyMs: DAY, when: 'ogni giorno alle 3:19', last: { at: Date.parse('2026-10-23T03:19:00+02:00'), outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(Date.parse('2026-10-23T03:19:00+02:00'))], runsToday: 1, who: 'script: backup.py', reportsTo: 'nessun messaggio' }),
    item({ key: 'launchd:com.prova.ore', provider: 'launchd', name: 'com.prova.ore', everyMs: 6 * H, when: 'ogni 6 ore', next: NOW + 5 * H, last: { at: NOW - H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - H)], runsToday: 3, who: 'script: copia.sh', reportsTo: 'nessun messaggio' }),
    item({ key: 'cron:pulizia-scratch', provider: 'openclaw', name: 'pulizia-scratch', everyMs: 7 * DAY, when: 'il lunedì', last: { at: NOW - 2 * DAY, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 2 * DAY)], runsToday: 0 }),
    item({ key: 'gh:prova/foto/.github/workflows/foto.yml', provider: 'github', name: 'prova/foto · foto.yml', everyMs: DAY, when: 'ogni giorno', next: NOW + 19 * H, nextApprox: true, expectedLast: NOW - 5 * H, last: { at: NOW - 5 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 5 * H)], runsToday: 1, who: 'GitHub Actions', reportsTo: 'GitHub' }),
    item({ key: 'cron:quote-muse', provider: 'openclaw', name: 'quote-muse', everyMs: 6 * H, when: 'ogni 6 ore', last: { at: NOW - 2 * H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 2 * H)], runsToday: 3 }),
    item({ key: 'cron:quote-codex', provider: 'openclaw', name: 'quote-codex', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - 6 * H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 6 * H)], runsToday: 1 }),
    item({ key: 'launchd:com.prova.residui', provider: 'launchd', name: 'com.prova.residui', everyMs: DAY, when: 'ogni giorno alle 7:00', expectedLast: NOW - 9 * H, last: { at: NOW - 9 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 9 * H)], runsToday: 1 }),
    item({ key: 'cron:battito', provider: 'openclaw', name: 'battito', everyMs: 5 * MIN, when: 'ogni 5 min', last: { at: NOW - 2 * MIN, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 2 * MIN), okAt(NOW - 7 * MIN)], runsToday: 190, who: 'Jarvis nella chat principale', reportsTo: "la tua chat, solo se c’è qualcosa" }),
    item({ key: 'launchd:com.prova.dischi', provider: 'launchd', name: 'com.prova.dischi', everyMs: DAY, when: 'ogni giorno alle 8:00', expectedLast: NOW - 8 * H, last: { at: NOW - 8 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 8 * H)], runsToday: 1 }),
    item({ key: 'cron:rete-casa', provider: 'openclaw', name: 'rete-casa', everyMs: H, when: 'ogni ora', last: { at: NOW - 30 * MIN, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 30 * MIN)], runsToday: 15 }),
    item({ key: 'gh:prova/rete/.github/workflows/lint.yml', provider: 'github', name: 'prova/rete · lint.yml', everyMs: DAY, when: 'ogni giorno', nextApprox: true, expectedLast: NOW - 7 * H, last: { at: NOW - 7 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 7 * H)], runsToday: 1, who: 'GitHub Actions', reportsTo: 'GitHub' }),
    item({ key: 'cron:pulizia-log', provider: 'openclaw', name: 'pulizia-log', everyMs: 7 * DAY, when: 'il martedì', last: { at: NOW - 3 * DAY, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 3 * DAY)], runsToday: 0 }),
    item({ key: 'cron:collaudo-rapido', provider: 'openclaw', name: 'collaudo-rapido', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - 9 * H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 9 * H)], runsToday: 1 }),
    item({ key: 'gh:prova/app/.github/workflows/collaudo.yml', provider: 'github', name: 'prova/app · collaudo.yml', everyMs: 7 * DAY, when: 'ogni settimana', nextApprox: true, expectedLast: NOW - 2 * DAY, last: { at: NOW - 2 * DAY, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 2 * DAY)], runsToday: 0, who: 'GitHub Actions', reportsTo: 'GitHub' }),
    item({ key: 'cron:verifica-prezzi', provider: 'openclaw', name: 'verifica-prezzi', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - 10 * H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 10 * H)], runsToday: 1 }),
  ];
  // Votate tutte tranne 5: quelle restano da confermare nel ripasso.
  const unvoted = new Set(['cron:rete-casa', 'cron:pulizia-log', 'cron:verifica-prezzi', 'cron:avvisi-tele', 'cron:quote-codex']);
  const rows = I.filter((it) => !unvoted.has(it.key)).map((it, n) => voteRow(it.key, D[it.key], it, `ok-v${n}`));
  const wfItems = [
    item({ key: 'workflow:riordino-prova', provider: 'workflow', name: 'riordino-prova', everyMs: null, when: 'quando lo lanci', last: { at: NOW - 2 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 2 * H), okAt(NOW - 26 * H)], runsToday: 1, who: 'Claude Code (workflow)', reportsTo: 'la sessione che lo lancia' }),
    item({ key: 'workflow:scaffale-prova', provider: 'workflow', name: 'scaffale-prova', everyMs: null, when: 'quando lo lanci', last: { at: NOW - DAY, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - DAY)], runsToday: 0, who: 'Claude Code (workflow)', reportsTo: 'la sessione che lo lancia' }),
  ];
  const phases = [{ title: 'Preparazione', total: 2, done: 2, failed: 0 }, { title: 'Esecuzione', total: 1, done: 1, failed: 0 }];
  const runs = [
    { runId: 'wf_000001', name: 'riordino-prova', summary: 'Tutto in ordine.', status: 'ok', at: NOW - 2 * H, durationMs: 90000, agents: 3, phases, file: 'wf_000001.json' },
    { runId: 'wf_000002', name: 'riordino-prova', summary: 'Tutto in ordine.', status: 'ok', at: NOW - 26 * H, durationMs: 80000, agents: 3, phases, file: 'wf_000002.json' },
    { runId: 'wf_000003', name: 'riordino-prova', summary: 'Tutto in ordine.', status: 'ok', at: NOW - 2 * DAY, durationMs: 85000, agents: 2, phases, file: 'wf_000003.json' },
    { runId: 'wf_000004', name: 'scaffale-prova', summary: 'Scaffale sistemato.', status: 'ok', at: NOW - DAY, durationMs: 60000, agents: 2, phases, file: 'wf_000004.json' },
    { runId: 'wf_000005', name: 'scaffale-prova', summary: 'Scaffale sistemato.', status: 'ok', at: NOW - 3 * DAY, durationMs: 61000, agents: 2, phases, file: 'wf_000005.json' },
    { runId: 'wf_000006', name: 'scaffale-prova', summary: 'Scaffale sistemato.', status: 'ok', at: NOW - 5 * DAY, durationMs: 59000, agents: 1, phases, file: 'wf_000006.json' },
  ];
  return assemble({
    items: I, descriptions: D, rows, wfItems, runs,
    sourceOver: { pc: { ok: true, asleep: true, at: NOW - 60000, items: [] } },
  });
}
// Due te, quattro rotte, una fusa da 4 fonti, una silenziata, GitHub in attesa.
export function buildProblemi() {
  const D = {
    'desktop:compito-festa': desc('Festa di prova da preparare', 'Doveva ricordare la festa di due giorni fa.', 'La sessione che lo ha creato.', 'arriva'),
    'lobster:report-lobster': desc('Resoconto del maggiordomo', 'Prepara il resoconto e aspetta il via per inviarlo.', 'Nessun messaggio finché non approvi.', 'arriva'),
    'cron:collaudo-settimanale': desc('Collaudo settimanale del prodotto', 'Esegue il collaudo lungo una volta a settimana.', 'Lo vedi su GitHub.', 'prodotti'),
    'launchd:com.prova.sicuro': desc('Aggiornamento sicuro del sistema', 'Applica ogni giorno gli aggiornamenti sicuri.', 'Nessun messaggio.', 'macchine'),
    'cron:avviso-giornaliero': desc('Avviso giornaliero in chat', 'Manda ogni giorno l’avviso in chat.', 'Ti scrive su WhatsApp.', 'arriva'),
    'cron:verifica-commit': desc('Verifica dei commit notturni', 'Controlla che i commit della notte siano arrivati nel repo.', 'Nessun messaggio.', 'dati'),
    'cron:sync-ore': desc('Sincronia ogni ora', 'Copia ogni ora le modifiche nel repo privato.', 'Nessun messaggio.', null, { object: 'copia-sito' }),
    'cron:sync-notte': desc('Sincronia notturna', 'Copia di notte tutto il sito nel repo privato.', 'Nessun messaggio.', null, { object: 'copia-sito' }),
    'launchd:com.prova.sincro': desc('Sincronia dal Mac', 'Sincronizza dal Mac i file del sito.', 'Nessun messaggio.', null, { object: 'copia-sito' }),
    'desktop:controllo-sync': desc('Controllo della sincronia', 'Verifica che la sincronia sia completa.', 'La sessione che lo ha creato.', null, { object: 'copia-sito' }),
    'object:copia-sito': { titolo: 'Copia del sito nel repo privato', cosa: 'Quattro strade diverse portano la stessa copia nel repo privato.', tiScrive: 'Nessun messaggio.', group: 'dati' },
    'cron:promemoria-rumoroso': desc('Promemoria rumoroso', 'Ricorda troppe cose troppo spesso.', 'Ti scrive su WhatsApp.', 'arriva'),
    'cron:riepilogo-sera': desc('Riepilogo della sera', 'Raccoglie i messaggi della giornata in un unico riepilogo.', 'Ti scrive su WhatsApp la sera.', 'arriva'),
    'cron:controllo-quote': desc('Controllo delle quote', 'Controlla quanto hai usato dei modelli.', 'Nessun messaggio.', 'quote'),
    'pc:attivita-serale': desc('Attività del PC di casa', 'Segna le attività serali del PC di casa.', 'Nessun messaggio.', null),
  };
  const I = [
    item({ key: 'desktop:compito-festa', provider: 'desktop', name: 'Festa di prova', everyMs: null, when: 'martedì alle 16:00', next: null, last: { at: null, outcome: null, delivered: null, error: null }, runs: [], runsToday: 0, who: 'Claude (app desktop)', reportsTo: "la sessione che l'ha creato", fireAt: NOW - 2 * DAY, neverRan: true, tech: { schedule: new Date(NOW - 2 * DAY).toISOString(), exit: null, command: null, prompt: 'Prepara la festa di prova.', label: 'festa', url: null } }),
    item({ key: 'cron:collaudo-settimanale', provider: 'openclaw', name: 'collaudo-settimanale', everyMs: 7 * DAY, when: 'la domenica', last: { at: SUN, outcome: 'error', delivered: 'none', error: 'exited with code 1' }, runs: [errAt(SUN)], consecutiveErrors: 1, runsToday: 0, who: 'Claude, poi Codex', reportsTo: 'GitHub', tech: { schedule: '19 3 * * 0', exit: 1, command: null, prompt: 'Esegui il collaudo settimanale.', label: 'collaudo-settimanale', url: null } }),
    item({ key: 'launchd:com.prova.sicuro', provider: 'launchd', name: 'com.prova.sicuro', everyMs: DAY, when: 'ogni giorno alle 4:00', next: NOW + 12 * H, expectedLast: NOW - 5 * H, last: { at: NOW - 5 * H, outcome: 'error', delivered: null, error: null }, runs: [errAt(NOW - 5 * H)], consecutiveErrors: 1, runsToday: 1, who: 'script: aggiorna.sh', reportsTo: 'nessun messaggio', tech: { schedule: '{"StartCalendarInterval":{"Hour":4}}', exit: 1, command: 'aggiorna.sh --sicuro', prompt: null, label: 'com.prova.sicuro', url: null } }),
    item({ key: 'cron:avviso-giornaliero', provider: 'openclaw', name: 'avviso-giornaliero', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - 2 * H, outcome: 'ok', delivered: 'failed', error: null }, runs: [okAt(NOW - 2 * H)], runsToday: 1, who: 'Claude', reportsTo: 'WhatsApp' }),
    item({ key: 'cron:verifica-commit', provider: 'openclaw', name: 'verifica-commit', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - H)], runsToday: 1 }),
    item({ key: 'cron:sync-ore', provider: 'openclaw', name: 'sync-ore', everyMs: H, when: 'ogni ora', last: { at: NOW - 10 * MIN, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 10 * MIN)], runsToday: 15 }),
    item({ key: 'cron:sync-notte', provider: 'openclaw', name: 'sync-notte', everyMs: DAY, when: 'ogni giorno alle 3:00', last: { at: NOW - 13 * H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 13 * H)], runsToday: 1 }),
    item({ key: 'launchd:com.prova.sincro', provider: 'launchd', name: 'com.prova.sincro', everyMs: DAY, when: 'ogni giorno alle 5:00', expectedLast: NOW - 11 * H, last: { at: NOW - 11 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 11 * H)], runsToday: 1 }),
    item({ key: 'desktop:controllo-sync', provider: 'desktop', name: 'Controllo della sincronia', everyMs: null, when: 'giovedì alle 14:00', next: null, last: { at: NOW - 26 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 26 * H)], runsToday: 0, who: 'Claude (app desktop)', reportsTo: "la sessione che l'ha creato", fireAt: NOW - 26 * H, neverRan: false, tech: { schedule: new Date(NOW - 26 * H).toISOString(), exit: null, command: null, prompt: 'Verifica la sincronia.', label: 'sync', url: null } }),
    item({ key: 'cron:promemoria-rumoroso', provider: 'openclaw', name: 'promemoria-rumoroso', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - H, outcome: 'ok', delivered: 'delivered', error: null }, runs: [okAt(NOW - H)], runsToday: 1 }),
    item({ key: 'cron:riepilogo-sera', provider: 'openclaw', name: 'riepilogo-sera', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - 2 * H, outcome: 'ok', delivered: 'delivered', error: null }, runs: [okAt(NOW - 2 * H)], runsToday: 1, who: 'Claude', reportsTo: 'WhatsApp' }),
    item({ key: 'cron:controllo-quote', provider: 'openclaw', name: 'controllo-quote', everyMs: DAY, when: 'ogni giorno', last: { at: NOW - 4 * H, outcome: 'ok', delivered: 'none', error: null }, runs: [okAt(NOW - 4 * H)], runsToday: 1 }),
    item({ key: 'pc:attivita-serale', provider: 'pc', name: 'attivita-serale', everyMs: null, when: 'ogni sera', next: NOW + 6 * H, last: { at: NOW - 2 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 2 * H)], runsToday: 1, who: 'PC di casa', reportsTo: 'nessun messaggio' }),
  ];
  const wfItems = [
    item({ key: 'workflow:riordino-prova', provider: 'workflow', name: 'riordino-prova', everyMs: null, when: 'quando lo lanci', last: { at: NOW - 3 * H, outcome: 'ok', delivered: null, error: null }, runs: [okAt(NOW - 3 * H)], runsToday: 1, who: 'Claude Code (workflow)', reportsTo: 'la sessione che lo lancia' }),
    item({ key: 'lobster:report-lobster', provider: 'lobster', name: 'report-lobster', everyMs: null, when: 'quando lo lancia Lobster', next: null, last: { at: NOW - 3 * H, outcome: 'running', delivered: null, error: null }, runs: [], consecutiveErrors: 0, runsToday: 0, who: 'Lobster', reportsTo: 'nessun messaggio', waitingApproval: { step: 'approva-invio', since: NOW - 3 * H, token: 'tok-finto', file: null }, tech: { schedule: null, exit: null, command: null, prompt: null, label: 'report-lobster', url: null } }),
  ];
  const rows = [
    { id: 'pb-m1', key: 'cron:promemoria-rumoroso', kind: 'mute', until: null, why: 'troppo insistente', at: iso(NOW - DAY), by: 'operatore', src: 'hub' },
    voteRow('cron:riepilogo-sera', D['cron:riepilogo-sera'], I.find((i) => i.key === 'cron:riepilogo-sera'), 'pb-v1'),
    voteRow('cron:controllo-quote', D['cron:controllo-quote'], I.find((i) => i.key === 'cron:controllo-quote'), 'pb-v2'),
  ];
  const phasesOk = [{ title: 'Preparazione', total: 2, done: 2, failed: 0 }];
  const phasesKo = [{ title: 'Preparazione', total: 2, done: 1, failed: 1 }, { title: 'Esecuzione', total: 1, done: 0, failed: 1 }];
  const runs = [
    { runId: 'wf_000011', name: 'riordino-prova', summary: 'Tutto in ordine.', status: 'ok', at: NOW - 3 * H, durationMs: 90000, agents: 3, phases: phasesOk, file: 'wf_000011.json' },
    { runId: 'wf_000012', name: 'riordino-prova', summary: 'Fallito in esecuzione.', status: 'error', at: NOW - 27 * H, durationMs: 40000, agents: 3, phases: phasesKo, file: 'wf_000012.json' },
    { runId: 'wf_000013', name: 'riordino-prova', summary: 'Tutto in ordine.', status: 'ok', at: NOW - 2 * DAY, durationMs: 85000, agents: 2, phases: phasesOk, file: 'wf_000013.json' },
    { runId: 'wf_000014', name: 'riordino-prova', summary: 'Tutto in ordine.', status: 'ok', at: NOW - 4 * DAY, durationMs: 80000, agents: 2, phases: phasesOk, file: 'wf_000014.json' },
    { runId: 'wf_000015', name: 'scaffale-prova', summary: 'Fallito in preparazione.', status: 'error', at: NOW - DAY, durationMs: 30000, agents: 1, phases: phasesKo, file: 'wf_000015.json' },
    { runId: 'wf_000016', name: 'scaffale-prova', summary: 'Scaffale sistemato.', status: 'ok', at: NOW - 2 * DAY, durationMs: 60000, agents: 2, phases: phasesOk, file: 'wf_000016.json' },
    { runId: 'wf_000017', name: 'scaffale-prova', summary: 'Scaffale sistemato.', status: 'ok', at: NOW - 5 * DAY, durationMs: 59000, agents: 1, phases: phasesOk, file: 'wf_000017.json' },
    { runId: 'wf_000018', name: 'scaffale-prova', summary: 'Scaffale sistemato.', status: 'ok', at: NOW - 6 * DAY, durationMs: 61000, agents: 1, phases: phasesOk, file: 'wf_000018.json' },
  ];
  return assemble({
    items: I, descriptions: D, rows, wfItems, runs,
    sourceOver: { github: { ok: false, pending: true, at: null, items: [] } },
    modelOver: { proofs: { 'cron:verifica-commit': { ok: false, at: NOW - 30 * MIN, words: 'manca la prova: nessun commit tra le 4:32 e le 5:30' } } },
  });
}

// Scrive i due JSON quando lanciato direttamente.
const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(here, 'make-models.mjs')) {
  fs.writeFileSync(path.join(here, 'model-ok.json'), `${JSON.stringify(buildOk(), null, 2)}\n`);
  fs.writeFileSync(path.join(here, 'model-problemi.json'), `${JSON.stringify(buildProblemi(), null, 2)}\n`);
  console.log('model-ok.json e model-problemi.json scritti');
}
