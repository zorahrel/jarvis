// Esito della misura di 12 ore sul gateway OpenClaw (launchd com.jarvis.oc-misura12h, ogni giorno alle 10:45).
// Giudica solo il processo gateway che gira adesso (pid da `launchctl list`): i pid precedenti restano in tabella
// come storia e non fanno mai scattare l'allarme. Stima la deriva del footprint (regressione semplice, senza la
// prima ora di warm-up del processo), scrive l'esito nel file di ricerca del repo jarvis e committa solo quel file.
// Sopra soglia apre una card sulla board. Il plist va in disabled/ solo quando il processo corrente è stato giudicato.
// Uso: node esito-12h.mjs [--dry-run]   (--dry-run: stampa e basta, niente file, niente card, niente bootout)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const HOME = os.homedir();
const DIR = path.join(HOME, '.cache', 'oc-heapwatch', 'cont');
const REPO = path.join(HOME, '.claude', 'jarvis');
const RESULTS = path.join(REPO, 'tools', 'usage-hub', 'docs', 'oc-memoria-12h.md');
const BOARD_CARD = path.join(REPO, 'scripts', 'board-card');
const SOGLIA = 50; // MB/h: sopra questa deriva sul processo corrente si apre la card
const WARMUP_MIN = 60; // minuti dopo l'avvio del processo esclusi dalla regressione
const MIN_WINDOWS = 8; // sotto questo numero di finestre dopo il warm-up il processo non si giudica
const GATEWAY = 'ai.openclaw.gateway';
const LABEL = 'com.jarvis.oc-misura12h';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const PARKED = path.join(HOME, 'Library', 'LaunchAgents', 'disabled', `${LABEL}.plist`);

// pid del gateway in esecuzione: `launchctl list` dà «pid stato etichetta», con il trattino il processo è fermo
const currentPid = () => {
  const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
  const row = out.split('\n').map((l) => l.split('\t')).find((c) => c[2] === GATEWAY);
  return row && /^\d+$/.test(row[0]) ? row[0] : null;
};

// il footprint può andare a capo (grep -o su due righe): ogni riga inizia con {"start"
const raw = fs.readFileSync(path.join(DIR, 'windows.jsonl'), 'utf8').replace(/\n(?!\{"start")/g, ' ');
const windows = raw.split('\n').filter(Boolean).map((l) => {
  const m = l.match(/"footprint":"\s*([\d.]+)\s*MB"/);
  const r = JSON.parse(l.replace(/"footprint":"[^"]*"/, '"footprint":""'));
  return { ...r, footprintMB: m ? Number(m[1]) : null };
});

const groups = new Map();
for (const w of windows) {
  const key = `${w.ver || '?'}|${w.pid}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(w);
}

const slope = (pts) => {
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  const num = pts.reduce((a, p) => a + (p.t - mt) * (p.y - my), 0);
  const den = pts.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  return den ? num / den : 0;
};

const cur = currentPid();
const rows = [];
for (const [key, ws] of groups) {
  const [ver, pid] = key.split('|');
  const start = Date.parse(ws[0].start);
  const pts = ws
    .filter((w) => w.footprintMB !== null)
    .map((w) => ({ t: (Date.parse(w.end) - start) / 3600e3, y: w.footprintMB, end: w.end }))
    .filter((p) => p.t * 60 >= WARMUP_MIN);
  const all = ws.filter((w) => w.footprintMB !== null).map((w) => w.footprintMB);
  const builds = ws.reduce((a, w) => a + Math.max(0, w.buildsAfter - w.buildsBefore), 0);
  const drift = pts.length >= MIN_WINDOWS ? slope(pts) : null;
  rows.push({
    ver, pid, isCurrent: pid === cur, post: pts.length, drift,
    windows: ws.length, footprint: all.length ? `${Math.min(...all)}–${Math.max(...all)} MB` : 'n/d',
    from: ws[0].start.slice(11, 16), to: ws[ws.length - 1].end.slice(11, 16), builds,
  });
}

const curRow = rows.find((r) => r.isCurrent);
const judged = curRow && curRow.drift !== null ? curRow : null;
const exceeded = judged && judged.drift > SOGLIA ? judged : null;

const total = windows.length;
const ora = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).slice(0, 16);
const header = `#### Esito automatico della misura di 12 h (${ora})`;
const table = [
  '| versione | pid | stato | finestre | periodo | footprint | deriva | build create (tutti i processi) |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.ver} | ${r.pid} | ${r.isCurrent ? 'corrente' : 'storia'} | ${r.windows} | ${r.from}–${r.to} | ${r.footprint} | ${r.drift === null ? `non giudicata (${r.post}/${MIN_WINDOWS} finestre)` : `${r.drift.toFixed(0)} MB/h`} | ${r.builds} |`),
].join('\n');
let verdict;
if (!cur) verdict = 'Gateway non in esecuzione: nessun processo da giudicare.';
else if (!judged) verdict = `**Processo corrente ${cur} non ancora giudicato**: ${curRow ? curRow.post : 0} finestre dopo il warm-up, ne servono ${MIN_WINDOWS}.`;
else if (exceeded) verdict = `**Sopra la soglia di ${SOGLIA} MB/h** sul processo corrente ${judged.pid} (versione ${judged.ver}): deriva ${judged.drift.toFixed(0)} MB/h su ${judged.post} finestre dopo il warm-up.`;
else verdict = `**Sotto la soglia di ${SOGLIA} MB/h** sul processo corrente ${judged.pid} (versione ${judged.ver}): deriva ${judged.drift.toFixed(0)} MB/h su ${judged.post} finestre dopo il warm-up.`;
const block = `\n${header}\n\n${verdict}\n\n${table}\n\n_${total} finestre in totale; i pid precedenti sono storia e non giudicano._\n`;

console.log(block);
if (DRY) process.exit(0);

// il file di ricerca di claude-usage-hub non esiste più: l'esito sta qui, nel repo jarvis
if (!fs.existsSync(RESULTS)) {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, '# Memoria del gateway OpenClaw: misura di 12 ore\n');
}
fs.appendFileSync(RESULTS, block);
execFileSync('git', ['-C', REPO, 'add', '--', RESULTS]);
execFileSync('git', ['-C', REPO, 'commit', '-q', '-o',
  '-m', 'docs: esito della misura di 12 h sul gateway OpenClaw',
  '-m', 'Il file di ricerca di claude-usage-hub non esiste: l\'esito della misura va qui, nel repo jarvis. Commit solo di questo file.',
  '--', RESULTS]);

// se la card non si apre (Topics giù) lo script esce in errore prima di parcheggiare: domani si riprova
if (exceeded) {
  execFileSync(BOARD_CARD, ['--key', 'oc-memoria-deriva', '--title', '[Jarvis] Il gateway OpenClaw perde memoria',
    '--desc', `Deriva ${exceeded.drift.toFixed(0)} MB/h sul processo ${exceeded.pid} (OpenClaw ${exceeded.ver}), ${exceeded.post} finestre dopo il warm-up, soglia ${SOGLIA} MB/h. Esito: ${RESULTS}`]);
}

// processo corrente giudicato: la misura è chiusa, il plist va in disabled/ (non riparte al login)
if (judged && fs.existsSync(PLIST)) {
  fs.renameSync(PLIST, PARKED);
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]); } catch { /* già fuori */ }
}
