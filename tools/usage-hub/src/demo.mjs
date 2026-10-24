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
// Un --demo ucciso con SIGKILL non fa girare 'exit': alla partenza si tolgono le cartelle demo di un'ora fa
// il cui processo (scritto in .pid da removeOnExit) non c'è più. Una demo ancora accesa resta.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Le cartelle di prova che contengono demo (demo-tmp-*, ui-bar-*, ux-proofs-*, prova-automazioni-*): un giro
// interrotto le lasciava in $TMPDIR per sempre (16 + 56 + 10 il 24/10). Si tolgono vecchie di 1 ora e senza
// nessun .pid vivo dentro. Le demo morte si cercano a qualunque profondità (giro 9: 11 annidate in hub-test-* e
// nei tmp* di Python restavano perché lo sweep guardava solo il primo livello), e la cartella che le conteneva
// sparisce solo se resta vuota: una cartella non nostra non si tocca.
const PROOF_DIR = /^(?:demo-tmp-|ui-bar-|ux-proofs-|prova-automazioni-)/;
const DEMO_DIR = /^usage-hub-demo-/;
const HOUR = 3600000;
const MAX_DEPTH = 6;
const subdirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => path.join(p, d.name)); } catch { return []; } };
function livePidInside(p, depth = MAX_DEPTH) {
  try {
    const pid = Number(fs.readFileSync(path.join(p, '.pid'), 'utf8').trim() || 0) || 0;
    if (pid && alive(pid)) return true;
  } catch { /* nessun .pid qui */ }
  return depth > 0 && subdirs(p).some((d) => livePidInside(d, depth - 1));
}
// l'età è quella del file più recente dentro: una cartella vecchia con dentro una demo appena scritta non è vecchia
function newestMtime(p, depth = MAX_DEPTH) {
  let m = 0;
  try { m = fs.statSync(p).mtimeMs; } catch { return Infinity; }
  if (depth > 0) for (const d of subdirs(p)) m = Math.max(m, newestMtime(d, depth - 1));
  return m;
}
export function sweepStaleDemoRoots(dir = os.tmpdir(), now = Date.now()) {
  let n = 0;
  const old = (p) => now - newestMtime(p) > HOUR;
  const drop = (p) => { fs.rmSync(p, { recursive: true, force: true }); n++; };
  // torna true se ha tolto qualcosa sotto d: solo allora una cartella rimasta vuota si toglie
  const walk = (d, depth) => {
    let dropped = false;
    for (const p of subdirs(d)) {
      const name = path.basename(p);
      if (DEMO_DIR.test(name)) { if (old(p) && !livePidInside(p)) { drop(p); dropped = true; } continue; }
      if (depth === 0 && PROOF_DIR.test(name) && old(p) && !livePidInside(p)) { drop(p); dropped = true; continue; }
      if (depth >= MAX_DEPTH || !walk(p, depth + 1)) continue;
      dropped = true;
      try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* non vuota: dentro c'è altro, resta */ }
    }
    return dropped;
  };
  walk(dir, 0);
  return n;
}

export function removeOnExit(root) {
  try { fs.writeFileSync(path.join(root, '.pid'), String(process.pid)); } catch { /* senza .pid la pulizia guarda solo l'età */ }
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
    // testi lunghi senza spazi, come un percorso: non devono far scorrere la pagina in orizzontale
    { kind: 'apri', id: 'es3', tipo: 'decisione', title: 'Scegli dove salvare /esempio/cartella_molto_lunga_senza_spazi/sottocartella_di_prova', why: 'Il file /esempio/progetti/cliente_di_prova/documenti_condivisi/versione_finale_definitiva.pdf è in due posti.', from: 'agente_di_prova_con_un_nome_molto_lungo_senza_spazi', at: now - 20 * 60000 },
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
    // il nome lungo è il più recente dei fermi, così compare anche fra i primi di Progetti
    const at = i === 0 ? now - 600000 : now - 7200000;
    const lines = Array.from({ length: i === 0 ? 60 : 3 + i }, (_, k) => JSON.stringify({ timestamp: new Date(at - k * 1000).toISOString(), cwd: `/work/${name}`,
      message: { id: `c${i}-${k}`, usage: { input_tokens: 10, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 } } }));
    fs.writeFileSync(path.join(dir, 's.jsonl'), lines.join('\n') + '\n');
  });
  // e qualche sessione Muse, così Consumi ha la sua tabella (in demo era «Nessuna attività Muse»)
  const d = new Date(now), ymd = [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')];
  ['billing-api', 'docs-site', 'infra'].forEach((name, i) => {
    const dir = path.join(root, 'muse', ...ymd, `sess-${i}`); fs.mkdirSync(dir, { recursive: true });
    const ev = (k) => JSON.stringify({ payload_type: 'runtime.session', recorded_at: (now - 1800000 - k * 1000) * 1000, payload: { event: { kind: 'model_completed', model: 'muse-1', usage: { input_tokens: 4000 * (3 - i), output_tokens: 900 } } } });
    fs.writeFileSync(path.join(dir, 'session.jsonl'), [JSON.stringify({ payload_type: 'runtime.session.metadata', payload: { record: { workspace_root: `/work/${name}` } } }), ...Array.from({ length: 4 }, (_, k) => ev(k))].join('\n') + '\n');
  });
  return root;
}
