// Attendibilità dei processi: chi ha firmato l'eseguibile, da dove gira, se ascolta sulla rete aperta, se brucia CPU da tanto.
// Serve agli agenti (GET /api/mac/trust) e alla tray; i casi gravi arrivano su WhatsApp, uno per eseguibile al giorno.
// La firma si legge una volta per eseguibile (cache su percorso + mtime): a regime un giro costa un `ps` e un `lsof`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const BIN = { codesign: '/usr/bin/codesign', ps: '/bin/ps', lsof: '/usr/sbin/lsof' };
// codesign scrive su stderr e lsof esce 1 anche con l'elenco pieno: si tiene tutto quello che hanno detto
const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(BIN[cmd] || cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => resolve(String(out || '') + String(errOut || '')));
});

// «Signature=adhoc» = firmato da chi l'ha compilato, senza identità (node di Homebrew, i binari fatti in casa): non è un allarme da solo.
export function parseCodesign(out) {
  if (/not signed at all/.test(out)) return { signer: 'nessuna' };
  if (/invalid signature|code object is not signed|has been modified/i.test(out) && !/Authority=|Signature=adhoc/.test(out)) return { signer: 'non valida' };
  if (/Signature=adhoc/.test(out)) return { signer: 'adhoc' };
  const auth = (/Authority=([^\n]+)/.exec(out) || [])[1] || '';
  const team = (/TeamIdentifier=([^\n]+)/.exec(out) || [])[1];
  if (/^Software Signing$|^Apple Mac OS Application Signing$/.test(auth)) return { signer: 'apple', authority: auth };
  if (auth) return { signer: 'sviluppatore', authority: auth.replace(/^(Developer ID Application|Apple Development|Apple Distribution): /, ''), team: team && team !== 'not set' ? team : null };
  return { signer: 'sconosciuta' };
}

// Dove non dovrebbe stare un programma installato: le cartelle temporanee, gli scaricati, la cartella condivisa.
export function riskyPlace(p, home = os.homedir()) {
  if (!p) return null;
  if (/^\/(private\/)?(tmp|var\/folders)\//.test(p)) return 'cartella temporanea';
  if (p.startsWith(home + '/Downloads/')) return 'Download';
  if (p.startsWith('/Users/Shared/')) return 'cartella condivisa';
  return null;
}

const INTERP = /^(node|bun|deno|python[\d.]*|ruby|perl|sh|bash|zsh)$/;
// Lo script di un interprete: il primo argomento che non è un'opzione e ha l'aria di un file.
export function scriptOf(command) {
  const a = (command || '').split(/\s+/); const exe = (a[0] || '').split('/').pop();
  if (!INTERP.test(exe)) return null;
  const s = a.slice(1).find((x) => x && !x.startsWith('-') && /[/.]/.test(x));
  return s && s.startsWith('/') ? s : null;
}

export const SUSTAINED_MS = 10 * 60000;
// Livello e motivi di un processo. «grave» solo quando due segnali si sommano: un eseguibile sospetto (posizione, firma
// rotta, file cancellato) che in più è esposto in rete o tiene la CPU alta da 10 minuti; è la forma di un miner o di una backdoor.
export function assess(p, { now = Date.now() } = {}) {
  const reasons = [];
  const trusted = p.sign && (p.sign.signer === 'apple' || p.sign.signer === 'sviluppatore');
  const exposed = (p.listen || []).length > 0;
  const hot = p.hotSince != null && now - p.hotSince >= SUSTAINED_MS;
  let suspect = false;
  // dentro un .app cancellato = l'app si è aggiornata su disco e questa è la copia vecchia ancora aperta: normale, va solo riavviata
  if (p.deleted && /\.app\//.test(p.path || '')) reasons.push("aggiornata su disco: questa è la versione vecchia, riavviala");
  else if (p.deleted) { suspect = true; reasons.push('eseguibile cancellato dal disco mentre gira'); }
  if (p.sign && p.sign.signer === 'non valida') { suspect = true; reasons.push('firma non valida o alterata'); }
  const place = riskyPlace(p.path, p.home);
  if (place && !trusted) { suspect = true; reasons.push(`eseguibile non firmato da ${place}`); }
  const sPlace = riskyPlace(p.script, p.home);
  if (sPlace) reasons.push(`script da ${sPlace}`);
  // anche per i firmati: la regola di casa è niente porte in LAN (accesso remoto via tailscale serve); per loro resta un'informazione
  if (exposed) reasons.push(`in ascolto su tutta la rete (${[...new Set(p.listen)].slice(0, 3).join(', ')}), non solo sul Mac`);
  if (hot && !trusted) reasons.push(`CPU sopra l'80% da ${Math.round((now - p.hotSince) / 60000)} min`);
  let level = 'ok';
  if (suspect && (exposed || hot)) level = 'grave';
  else if (suspect || (exposed && !trusted) || (sPlace && exposed)) level = 'attenzione';
  return { level, reasons };
}

// lsof: «nome pid … TCP *:3333 (LISTEN)». Conta solo chi ascolta fuori dal Mac: 127.0.0.1 e ::1 non sono esposti.
export function parseListen(out) {
  const by = new Map();
  for (const l of out.split('\n').slice(1)) {
    const f = l.trim().split(/\s+/); const pid = Number(f[1]); const addr = f[f.length - 2] || '';
    if (!pid || /^(127\.|\[::1\]|localhost)/.test(addr)) continue;
    (by.get(pid) || by.set(pid, []).get(pid)).push(addr);
  }
  return by;
}

export function createTrust({ exec = run, now = Date.now, home = os.homedir(), allow = [] } = {}) {
  const signs = new Map();   // percorso → { mtime, sign }
  const hot = new Map();     // pid → da quando è sopra l'80%
  let last = { at: 0, items: [] };
  async function signOf(p) {
    if (/M-|\^[@-_]/.test(p)) return {};   // ps codifica i caratteri non ASCII (Ü → M-^\): il percorso non si apre, non vuol dire cancellato
    let st; try { st = fs.statSync(p); } catch { return { deleted: true }; }
    const c = signs.get(p);
    if (c && c.mtime === st.mtimeMs) return { sign: c.sign };
    const sign = parseCodesign(await exec('codesign', ['-dv', '--verbose=2', p], 4000));
    signs.set(p, { mtime: st.mtimeMs, sign });
    return { sign };
  }
  async function scan() {
    const t = now();
    // comm in colonna finale da solo: in mezzo ps lo tronca alla larghezza della colonna, e i percorsi hanno spazi
    const [ps, pc, ls] = await Promise.all([exec('ps', ['-axo', 'pid=,pcpu=,command='], 6000), exec('ps', ['-axo', 'pid=,comm='], 6000), exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], 6000)]);
    const listen = parseListen(ls);
    const pathOf = new Map(pc.split('\n').map((l) => /^\s*(\d+)\s+(.+)$/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2].trim()]));
    const rows = ps.split('\n').map((l) => /^\s*(\d+)\s+([\d.]+)\s+(.*)$/.exec(l)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), cpu: Number(m[2]), path: pathOf.get(Number(m[1])) || '', command: m[3] }));
    const seen = new Set();
    for (const r of rows) { seen.add(r.pid); if (r.cpu >= 80) { if (!hot.has(r.pid)) hot.set(r.pid, t); } else hot.delete(r.pid); }
    for (const pid of hot.keys()) if (!seen.has(pid)) hot.delete(pid);
    const items = [];
    // codesign in fila, quattro alla volta: il primo giro legge qualche centinaio di eseguibili, poi è tutto in cache
    const paths = [...new Set(rows.map((r) => r.path).filter((p) => p.startsWith('/')))];
    const info = new Map();
    for (let i = 0; i < paths.length; i += 4) await Promise.all(paths.slice(i, i + 4).map(async (p) => info.set(p, await signOf(p))));
    for (const r of rows) {
      if (!r.path.startsWith('/') || allow.some((a) => r.path === a || r.path.startsWith(a + '/'))) continue;
      const s = info.get(r.path) || {};
      const p = { ...r, ...s, script: scriptOf(r.command), listen: listen.get(r.pid) || [], hotSince: hot.get(r.pid), home };
      const a = assess(p, { now: t });
      items.push({ pid: r.pid, name: r.path.split('/').pop(), path: r.path, script: p.script, signer: s.deleted ? 'cancellato' : (s.sign || {}).signer, authority: (s.sign || {}).authority || null, team: (s.sign || {}).team || null, listen: p.listen, cpu: r.cpu, ...a });
    }
    last = { at: t, items };
    return last;
  }
  return {
    scan,
    get last() { return last; },
    // Per gli agenti: prima i gravi, poi le attenzioni; gli «ok» solo se chiesti.
    report({ all = false } = {}) {
      const rank = { grave: 0, attenzione: 1, ok: 2 };
      const items = last.items.filter((i) => all || i.level !== 'ok').sort((a, b) => rank[a.level] - rank[b.level] || b.cpu - a.cpu);
      const counts = { grave: 0, attenzione: 0, ok: 0 }; for (const i of last.items) counts[i.level]++;
      return { at: last.at, counts, items, note: 'grave = eseguibile sospetto (posizione, firma, cancellato) ed esposto in rete o a CPU alta da 10 min; attenzione = un segnale solo. Firmati Apple o con Developer ID non scattano mai per rete o CPU.' };
    },
  };
}

// Un messaggio per eseguibile al giorno: un miner che resta acceso non deve riempire WhatsApp.
// Il registro sta su file: senza, ogni riavvio del hub rimandava lo stesso avviso.
export function createTrustAlert({ send, now = Date.now, everyMs = 86400000, file = null } = {}) {
  let sent = new Map();
  if (file) { try { sent = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { /* primo avvio */ } }
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(Object.fromEntries(sent))); } catch { /* resta in memoria */ } };
  return async (items) => {
    const t = now();
    const fresh = items.filter((i) => i.level === 'grave' && !(sent.get(i.path) > t - everyMs));
    if (!fresh.length) return 0;
    for (const i of fresh) sent.set(i.path, t);
    for (const [p, at] of sent) if (at < t - everyMs) sent.delete(p);
    save();
    await send(`⚠️ Mac: ${fresh.length === 1 ? 'un processo sospetto' : fresh.length + ' processi sospetti'}\n` + fresh.slice(0, 5).map((i) => `• ${i.name} (pid ${i.pid}) ${i.path}\n  ${i.reasons.join('; ')}`).join('\n') + '\nDettagli: tray › Mac, o GET :3360/api/mac/trust');
    return fresh.length;
  };
}
