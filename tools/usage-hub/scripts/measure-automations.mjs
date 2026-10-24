#!/usr/bin/env node
// Misure della scheda Automazioni su un serve a parte (il :3360 vivo non si tocca). Esce 1 se una misura sfora.
//   --demo  serve --demo con la fixture «tutto ok»: 0 schede aperte, solo verdetto e righe grigie
//   --live  serve --no-live con le fonti vere: prima richiesta < 3 s (a freddo), seconda < 300 ms (a caldo),
//           e ogni automazione mostrata ha titolo ed esito (una descrizione mancante la scrive l'agente)
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['--demo', '--live'].includes(mode)) { console.error('uso: measure-automations.mjs --demo|--live'); process.exit(2); }
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const args = ['bin/usage-hub.mjs', 'serve', '--port', String(port), ...(mode === '--demo' ? ['--demo'] : ['--no-live'])];
const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, USAGE_HUB_DEMO_AUTOMATIONS: 'ok' }, stdio: ['ignore', 'ignore', 'pipe'] });
const fail = [];
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('serve non parte in 30 s')), 30000);
    child.stderr.on('data', (d) => { if (String(d).includes('usage-hub on')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => reject(new Error('serve uscito con ' + c)));
  });
  const get = async () => { const t = performance.now(); const r = await fetch(`http://127.0.0.1:${port}/api/automations`); const body = await r.json(); return { ms: performance.now() - t, body, status: r.status }; };
  const a = await get();
  if (a.status !== 200) throw new Error(`/api/automations risponde ${a.status}: ${JSON.stringify(a.body).slice(0, 200)}`);
  if (mode === '--demo') {
    // Il repo è ESM: require del file del browser non dà module.exports, la vista si appende al globale.
    createRequire(import.meta.url)(path.join(root, 'public/automations-view.js'));
    const { render } = globalThis.AutomationsView;
    const html = render(a.body, { now: a.body.checkedAt });
    // tolti i <details> chiusi (dal più interno), nessuna card deve restare a vista
    let flat = html;
    for (let i = 0; i < 8; i++) flat = flat.replace(/<details\b(?![^>]*\bopen\b)[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/g, '');
    const open = (flat.match(/class="au-card/g) || []).length;
    console.log(`demo: ${a.body.verdict.needsYou} ti aspettano, ${a.body.verdict.broken} rotte, ${open} schede aperte`);
    if (a.body.verdict.needsYou || a.body.verdict.broken || open) fail.push(`con «tutto ok» ci sono ${open} schede aperte`);
  } else {
    const b = await get();
    const cards = Object.values(a.body.cards || {});
    const missing = cards.filter((c) => c.missing || !c.title || !c.group).map((c) => c.key);
    console.log(`live: prima richiesta ${Math.round(a.ms)} ms, seconda ${Math.round(b.ms)} ms, ${cards.length} schede, ${missing.length} senza descrizione`);
    if (a.ms >= 3000) fail.push(`prima richiesta ${Math.round(a.ms)} ms (soglia 3000)`);
    if (b.ms >= 300) fail.push(`seconda richiesta ${Math.round(b.ms)} ms (soglia 300)`);
    if (missing.length) fail.push('senza titolo o esito: ' + missing.join(', '));
    // P05: la tabella dei progetti mostra il consumo vero della settimana. Il serve --no-live non lo calcola,
    // quindi si legge dal :3360 vivo, solo in GET: almeno 3 progetti vivi con una percentuale sopra zero.
    const live = await fetch('http://127.0.0.1:3360/api/live', { signal: AbortSignal.timeout(60000) }).then((r) => r.json()).catch(() => null);
    const withUse = ((live && live.projects) || []).filter((p) => !p.dead && (p.total || 0) > 0);
    console.log(`progetti vivi con consumo della settimana: ${withUse.length} (${withUse.slice(0, 3).map((p) => p.name + ' ' + p.total + '%').join(', ')})`);
    if (withUse.length < 3) fail.push(`solo ${withUse.length} progetti vivi con consumo nella tabella (minimo 3)`);
    // e per sessione: per ogni provider con sessioni che hanno token, almeno una deve avere la quota della settimana (use.pct)
    const sess = ((live && live.projects) || []).flatMap((p) => ((p.agents && p.agents.list) || []));
    for (const prov of ['claude', 'codex', 'muse']) {
      const withTok = sess.filter((a) => a.provider === prov && a.use && a.use.tokens > 0);
      const withPct = withTok.filter((a) => a.use.pct > 0);
      console.log(`sessioni ${prov}: ${withTok.length} con token, ${withPct.length} con la quota della settimana`);
      if (withTok.length && !withPct.length) fail.push(`nessuna sessione ${prov} con la quota della settimana (use.pct) su ${withTok.length} con token`);
    }
  }
} catch (e) { fail.push(e.message); }
child.kill();
for (const f of fail) console.error('ROSSO ' + f);
process.exit(fail.length ? 1 : 0);
