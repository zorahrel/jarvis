// Log finti generati al volo (timestamp freschi): servono a --demo e ai test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS = [
  ['billing-api', 400, 800], ['mobile-app', 250, 600], ['docs-site', 80, 300], ['infra', 30, 200],
];

export function makeDemoRoot(now = Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hub-demo-'));
  for (const [name, n, out] of PROJECTS) {
    const dir = path.join(root, `-work-${name}`);
    fs.mkdirSync(dir);
    const lines = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({
        timestamp: new Date(now - 3600000 - i * 1000).toISOString(),
        cwd: `/work/${name}`,
        message: { id: `m${i}`, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000 } },
      }));
    }
    fs.writeFileSync(path.join(dir, 's.jsonl'), lines.join('\n') + '\n');
  }
  return root;
}

// `usage-hub --demo` vive finché lo ferma qualcuno: la cartella dei log finti va tolta quando esce
// (ne restavano 1.100 in $TMPDIR). I segnali passano da process.exit perché il default non fa girare 'exit'.
export function removeOnExit(root) {
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(0));
  return root;
}

// Due voci di «Ti aspetta» e qualche riga di diario, inventate, per la demo.
export function seedDemoAttesa(root, now = Date.now()) {
  const f = path.join(root, 'ti-aspetta.jsonl');
  fs.writeFileSync(f, [
    { kind: 'apri', id: 'es1', tipo: 'spesa', title: 'Rinnovare un piano a pagamento', why: 'Spesa di prova: 19 dollari al mese.', from: 'demo', at: now - 3 * 3600000 },
    { kind: 'apri', id: 'es2', tipo: 'vista', title: 'Guarda una pagina nuova', why: 'Ok a vista di prova.', link: '#journal', from: 'demo', at: now - 40 * 60000 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}

export function seedDemoDiary(root, now = Date.now()) {
  const dir = path.join(root, 'diario');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  fs.writeFileSync(path.join(dir, day + '.jsonl'), [
    { ts: now - 50 * 60000, source: 'task-sync', text: 'nuova in Promemoria: preparare la demo per il cliente', outcome: 'ok' },
    { ts: now - 30 * 60000, source: 'freno-mac', text: 'Mac sotto sforzo per 12 minuti: nessun agente fermato', outcome: 'ok' },
    { ts: now - 10 * 60000, source: 'delega', text: 'lavoro di prova non riuscito: test rossi su billing-api', outcome: 'error' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

// Per la demo dell'hub (non per i test): tante cartelle piccole, così Consumi ha «Altri N», e un nome lungo,
// così a 375 px si vede se una riga esce dalla card.
export function addDemoCrowd(root, now = Date.now()) {
  const names = ['cartella_di_prova_con_un_nome_davvero_molto_lungo_e_senza_spazi_per_il_telefono', ...Array.from({ length: 19 }, (_, i) => `esperimento-${i + 1}`)];
  names.forEach((name, i) => {
    const dir = path.join(root, `-work-${name}`); fs.mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: 3 + i }, (_, k) => JSON.stringify({ timestamp: new Date(now - 7200000 - k * 1000).toISOString(), cwd: `/work/${name}`,
      message: { id: `c${i}-${k}`, usage: { input_tokens: 10, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 } } }));
    fs.writeFileSync(path.join(dir, 's.jsonl'), lines.join('\n') + '\n');
  });
  return root;
}
