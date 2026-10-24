#!/usr/bin/env node
// La barra sul vero: Topics e Promemoria veri, il task-sync.mjs vero (lo stesso che gira nel cron).
// Crea due voci di prova «[prova task-sync] …», le porta dall'altra parte, le chiude da una parte e guarda l'altra,
// poi spegne un lato per volta e controlla che il giro non scriva niente. Alla fine archivia le due card di prova
// (archiviare si annulla) e lascia le voci di prova completate. Esce 0 solo se tutto torna.
//   node scripts/task-sync/e2e.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topicsSide, remindersSide, BOARD, HOME, STATE_DIR } from './task-sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tag = `[prova task-sync] ${new Date().toISOString().slice(11, 19)}`;
let token = '';
try { token = execFileSync('security', ['find-generic-password', '-s', 'topics', '-a', 'agent-token', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const topics = topicsSide({ token }), rem = remindersSide();
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

function giro(env = {}) {
  const r = spawnSync('node', [path.join(here, 'task-sync.mjs')], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const boardCards = async () => (await topics.read(BOARD, [])).cards;
const remsHome = () => rem.read().filter((r) => r.list === HOME);

const madeCards = [];
try {
  // 1. Promemoria → Topics
  const rid = rem.create({ list: HOME, title: `${tag} da Promemoria`, notes: 'voce di prova del sync, si chiude da sola' });
  let g = giro();
  ok(g.code === 0, `giro 1 esce 0 (${g.code})`);
  const c1 = (await boardCards()).find((c) => c.title === `${tag} da Promemoria`);
  ok(!!c1, 'voce creata in Promemoria → card su Topics entro un giro');
  if (c1) madeCards.push(c1.id);

  // 2. Topics → Promemoria
  const c2 = (await topics.create(BOARD, { text: `${tag} da Topics`, status: 'backlog', description: 'card di prova del sync' })).id;
  madeCards.push(c2);
  g = giro();
  ok(g.code === 0, `giro 2 esce 0 (${g.code})`);
  const r2 = remsHome().find((r) => r.name === `${tag} da Topics`);
  ok(!!r2 && !r2.done, 'card creata su Topics → voce in Promemoria entro un giro');

  // 3. Chiusa in Promemoria → chiusa su Topics
  rem.edit(rid, { complete: true });
  // 4. Chiusa su Topics → chiusa in Promemoria
  await topics.patch(BOARD, c2, { status: 'done' });
  g = giro();
  ok(g.code === 0, `giro 3 esce 0 (${g.code})`);
  const after = await boardCards();
  ok(after.find((c) => c.id === c1?.id)?.cls === 'done', 'voce chiusa sul telefono → card done su Topics');
  ok(remsHome().find((r) => r.id === r2?.id)?.done === true, 'card chiusa su Topics → voce completata in Promemoria');

  // 4b. Titolo lungo con nota lunga: il 24/10 Topics li riscriveva in sottofondo («Patto Armonia: …» → «Versione con
  // riserva fissa per Attilio») e il sync portava il titolo nuovo anche sul telefono. La riscrittura arriva qualche
  // secondo dopo la creazione: si aspetta e si rilegge.
  const long = `${tag} Patto di prova: versione con riserva fissa, Jarvis prepara la bozza e la manda ad Attilio`;
  const ridLong = rem.create({ list: HOME, title: `► ${long}`, notes: 'Attilio 23/10: riserva fissa, non la proposta senza riserva. Jarvis prepara la versione, la rilegge e la manda ad Attilio per un ok prima di girarla a chiunque.' });
  giro();
  await new Promise((r) => setTimeout(r, 20000));
  giro();
  const cLong = (await boardCards()).find((c) => c.text.includes('Da Promemoria') && c.text.includes(ridLong.slice(0, 8)));
  if (cLong) madeCards.push(cLong.id);
  ok(cLong?.title === long, `titolo lungo intatto su Topics dopo 20 s (${cLong?.title?.slice(0, 60)})`);
  ok(remsHome().find((r) => r.id === ridLong)?.name === long, 'titolo lungo intatto in Promemoria');
  rem.edit(ridLong, { complete: true });

  // 5. Un lato giù: il giro esce 2 e non scrive niente da nessuna parte.
  const snap = () => JSON.stringify({ rems: rem.read().map((r) => [r.id, r.raw, r.done, r.due]).sort(), state: fs.readFileSync(path.join(STATE_DIR, 'links.json'), 'utf8') });
  const cardsSnap = async () => JSON.stringify((await boardCards()).map((c) => [c.id, c.title, c.status, c.due]).sort());
  // Una modifica in attesa su ciascun lato: se il giro scrivesse, si vedrebbe.
  const probe = rem.create({ list: HOME, title: `${tag} mentre Topics è giù`, notes: 'voce di prova del sync' });
  const beforeR = snap(), beforeC = await cardsSnap();
  g = giro({ TOPICS_URL: 'https://127.0.0.1:9' });
  ok(g.code === 2, `Topics giù → il giro esce 2 (${g.code}): ${g.out.trim().split('\n').pop()}`);
  ok(snap() === beforeR && (await cardsSnap()) === beforeC, 'Topics giù → niente scritto in Promemoria, su Topics, nello stato');
  g = giro({ REMINDCTL: '/usr/bin/false' });
  ok(g.code === 2, `Promemoria giù → il giro esce 2 (${g.code}): ${g.out.trim().split('\n').pop()}`);
  ok(snap() === beforeR && (await cardsSnap()) === beforeC, 'Promemoria giù → niente scritto su Topics, in Promemoria, nello stato');
  // Tornati su: la voce in attesa arriva.
  g = giro();
  const c3 = (await boardCards()).find((c) => c.title === `${tag} mentre Topics è giù`);
  ok(g.code === 0 && !!c3, 'lato di nuovo su → la voce in attesa arriva al giro dopo');
  if (c3) madeCards.push(c3.id);
  rem.edit(probe, { complete: true });
  giro();
} finally {
  // Pulizia: archiviare è reversibile (POST …/restore), le voci di prova restano completate.
  for (const id of madeCards) {
    try { await fetchArchive(id); } catch (e) { console.log(`pulizia: card ${id.slice(0, 8)} non archiviata: ${e.message}`); }
  }
}
console.log(fails ? `\n${fails} controlli falliti` : '\ntutti i controlli passano');
process.exit(fails ? 1 : 0);

async function fetchArchive(id) {
  const ca = fs.readFileSync(path.join(process.env.HOME, 'Projects/topics-app/certs/ca-cert.pem'));
  const { request } = await import('node:https');
  await new Promise((resolve, reject) => {
    const req = request({ method: 'DELETE', hostname: '127.0.0.1', port: 3333, path: `/api/boards/${BOARD}/tasks/${id}`, ca, headers: token ? { 'x-agent-token': token } : {} }, (res) => { res.resume(); res.on('end', () => (res.statusCode < 400 ? resolve() : reject(new Error(String(res.statusCode))))); });
    req.on('error', reject); req.end();
  });
}
