import '../test-support/isolate-tmp.mjs';
// Regola di Attilio: su WhatsApp solo italiano, una riga, niente id, niente gergo, niente compiti in inglese.
// Ogni testo che l'hub passa a sendWhatsApp (coda delega, freno del Mac, processi sospetti) passa di qui.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/queue.mjs';
import { createShedDigest } from '../src/shed.mjs';
import { createTrustAlert } from '../src/trust.mjs';

export function waProblems(text) {
  const out = [];
  const s = String(text);
  if (/\n/.test(s.trim())) out.push('più di una riga');
  // id esadecimale: almeno 6 caratteri con almeno una cifra e una lettera (così «accade» non conta)
  const hex = s.match(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/i);
  if (hex) out.push('id esadecimale «' + hex[0] + '»');
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) out.push('uuid');
  const key = s.match(/agent:[\w-]+:|openclaw-isolated[\w-]*|sessionKey|:subagent:|\bm-critic\w*/);
  if (key) out.push('chiave di sessione «' + key[0] + '»');
  if (/\bpid \d+/.test(s)) out.push('pid');
  if (/(^|\s)\/(Users|private|tmp|opt)\//.test(s) || /:\d{4}\/api\//.test(s)) out.push('percorso o indirizzo tecnico');
  return out;
}

const T0 = Date.UTC(2026, 9, 23, 21, 32);
const strained = { strained: true, byLoad: true, byMem: true };

test('waProblems: l\'esempio vero del 24/10 03:47 è rosso, una riga umana è verde', () => {
  assert.ok(waProblems('Coda delega:\n• in coda d515da (jarvis): Conta le righe del file agents/_shared/TOOLS.md in questa ca').length >= 2);
  assert.deepEqual(waProblems('Mac sotto sforzo dalle 23:32 alle 00:00: ho messo in pausa i lavori pesanti, tutto ripreso.'), []);
  assert.deepEqual(waProblems('Qui accade qualcosa di nuovo'), []);
});

test('coda delega: «in coda», «fallito» e «Risolvi tu» non arrivano su WhatsApp con id o compiti', () => {
  let t = 1e9; const sent = [], diary = [];
  const n = createNotifier({ send: (m) => sent.push(m), diary: (r) => diary.push(r), now: () => t });
  n.push('in coda d515da (jarvis): Conta le righe del file agents/_shared/TOOLS.md in questa ca');
  n.push('fallito (exit 1) d515da: Conta le righe del file agents/_shared/TOOLS.md');
  n.push('Risolvi tu 3f9a1c: Avviso giornaliero in chat');
  n.flush(); t += 20 * 60000; n.flush();
  for (const m of sent) assert.deepEqual(waProblems(m), [], m);
  assert.equal(diary.length, 3, 'il dettaglio va nel diario');
});

test('freno del Mac: su WhatsApp una riga umana, il dettaglio con le etichette nel diario', async () => {
  const sent = [], diary = [];
  const d = createShedDigest({ send: (x) => sent.push(x), diary: (r) => diary.push(r), restartGateway: () => true,
    hogs: async () => [{ name: 'gateway OpenClaw', kind: 'gateway', memMB: 6758, cpu: 0.3 }] });
  for (let m = 0; m <= 28; m++) await d.tick(strained, T0 + m * 60000);
  for (const label of ['jarvis · muse-job', 'openclaw-isolated-completion-36d62d20-4c1a-4b55-9b0e-0f2a7c1d9e11 · Jf6QiK', 'm-critic1 · codex-exec']) d.event({ type: 'pause', at: T0 + 300000, label });
  await d.flush(T0 + 39 * 60000);
  assert.equal(sent.length, 1);
  for (const m of sent) assert.deepEqual(waProblems(m), [], m);
  assert.equal(diary.length, 1);
});

test('processi sospetti: una riga senza pid né percorsi, i dettagli nel diario', async () => {
  const sent = [], diary = [];
  const alert = createTrustAlert({ send: (x) => sent.push(x), diary: (r) => diary.push(r), now: () => T0 });
  await alert([{ level: 'grave', name: 'helper', pid: 4242, path: '/private/tmp/0f2a7c1d-9e11-4b55-9b0e-36d62d204c1a/helper', reasons: ['non firmato', 'in una cartella temporanea'] }]);
  assert.equal(sent.length, 1);
  for (const m of sent) assert.deepEqual(waProblems(m), [], m);
  assert.equal(diary.length, 1);
});
