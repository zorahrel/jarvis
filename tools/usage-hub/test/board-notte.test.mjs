import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { escluso, leggiEsito, compito } from '../bin/board-notte';

const card = (over = {}) => ({ id: 'c1', projectId: 'b', status: 'backlog', text: '[Jarvis] Rifare il controllo', labels: [],
  description: `Fai la cosa.\n\nnotte: sì\ndir: ${os.homedir()}`, ...over });

test('entra solo la card marcata, in backlog, con una cartella vera', () => {
  assert.equal(escluso(card()), null);
  assert.equal(escluso(card({ description: 'Fai la cosa.' })), 'senza notte: sì');
  assert.equal(escluso(card({ status: 'in_progress' })), 'non in backlog');
  assert.equal(escluso(card({ description: 'x\nnotte: sì\ndir: /non/esiste' })), 'dir assente');
});

test('mai di notte: persone, soldi, decisioni, domande aperte', () => {
  for (const text of ['Invia la mail al cliente', 'Manda il report su WhatsApp', 'Pagare la fattura', 'Outreach LinkedIn'])
    assert.equal(escluso(card({ text })), 'tocca persone o soldi', text);
  assert.equal(escluso(card({ labels: [{ label: 'decisione', source: 'derived' }] })), 'è una decisione');
  assert.equal(escluso(card({ awaitingAnswer: true })), 'aspetta qualcosa');
});

test('una card già in coda o già lavorata non rientra finché la descrizione non cambia', () => {
  const c = card();
  assert.equal(escluso(c, { queue: [{ ref: 'card:b/c1', status: 'running' }] }), 'già in coda');
  assert.equal(escluso(c, { queue: [{ ref: 'card:b/c1', status: 'done' }] }), null);
});

test('il compito porta la card, la cartella e le righe finali da scrivere', () => {
  const t = compito(card());
  assert.match(t, /Rifare il controllo/);
  assert.match(t, new RegExp(`Lavora in ${os.homedir()}`));
  assert.match(t, /^ESITO: /m);
  assert.doesNotMatch(t, /^notte:/m);
});

test('esito letto dalle righe finali; senza righe, l\'ultima riga del log', () => {
  const e = leggiEsito('lavoro...\nESITO: fatto\nPROVA: node --test exit 0\nCOMMIT: abc1234\n[2026-10-25T03:00:00Z] x exit 0\n');
  assert.deepEqual([e.esito, e.prova, e.commit], ['fatto', 'node --test exit 0', 'abc1234']);
  const v = leggiEsito('ho provato\nnon trovo il file\n');
  assert.equal(v.esito, null);
  assert.equal(v.ultima, 'non trovo il file');
});
