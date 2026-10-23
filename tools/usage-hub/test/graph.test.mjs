import '../test-support/isolate-tmp.mjs';
// Schema a passi: i passi vengono dallo script e dal prompt veri, gli esiti dal log del giro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, extractSources, runEvents, graphForJob } from '../src/automations/graph.mjs';

const SCRIPT = `#!/bin/bash
ERRLOG="$HOME/logs/x.err.log"
log() { echo "$(date '+%F %T') brief-prova: $*" >> "$ERRLOG"; }
quota=$(curl -s -m 5 http://127.0.0.1:3335/api/profiles | python3 -c 'x')
limit 600 muse exec --model muse-spark-1.3 --prompt-file p > out
if [[ $rc -eq 0 ]]; then used=muse; fi
limit 600 claude -p --model sonnet --effort medium < p > out
limit 480 codex exec -m gpt-5.6-sol -C . -o out - < p
# Lista intera una volta al giorno
printf '\\n'; limit 90 todo-recap --full
# Automazioni: una riga se qualcosa aspetta
auto=$(curl -s http://127.0.0.1:3360/api/automations/summary)
open=$(curl -s http://127.0.0.1:3360/api/feedback)
`;

test('parseScript: modelli in ordine, ripiego, comandi personali e chiamate locali', () => {
  const s = parseScript(SCRIPT, new Set(['todo-recap']));
  assert.deepEqual(s.steps.map((x) => x.kind + ':' + (x.exec || x.label)), [
    'call:quota', 'model:muse', 'model:claude', 'model:codex', 'tool:Lista intera una volta al giorno', 'call:Automazioni: una riga se qualcosa aspetta',
  ]);
  assert.equal(s.chain, true);
  assert.equal(s.tag, 'brief-prova');
  assert.match(s.steps.at(-1).detail, /summary \+ :3360\/api\/feedback/);
});

test('extractSources: comandi e file del prompt; il file da scrivere è un\'uscita', () => {
  const src = extractSources('Esegui `date +%u`. Leggi ~/.openclaw/memory/decisioni.md e `gws-mail zorahrel gmail +triage`. Se esiste ~/.openclaw/proposte/<data>.md aggiungi. ULTIMO PASSO: scrivi in ~/.openclaw/privato/brief.md il messaggio.');
  assert.deepEqual(src.map((x) => x.label + (x.write ? '>' : '')), ['gws-mail zorahrel gmail', 'decisioni.md', 'proposte/', 'brief.md>']);
});

test('runEvents ed esiti: Muse fallisce, Claude saltato, Codex chiude', () => {
  const start = new Date('2026-10-10T07:30:00').getTime();
  const log = [
    '2026-10-09 07:30:07 brief-prova: muse fallito: vecchio giro',
    '2026-10-10 07:30:07 brief-prova: muse fallito: Muse è uscito con errore 1',
    '2026-10-10 07:30:07 brief-prova: salto claude: quota Claude finita',
    '2026-10-10 07:31:14 brief-prova: brief fatto con codex (quota finita)',
  ].join('\n');
  const ev = runEvents(log, 'brief-prova', start, start + 80000);
  assert.deepEqual(ev.map((e) => e.exec + ':' + e.kind), ['muse:error', 'claude:skipped', 'codex:ok']);
});

test('graphForJob senza script leggibile: un nodo comando, mai passi inventati', () => {
  const job = { id: 'x', name: 'prova', schedule: { kind: 'cron', expr: '30 7 * * *' }, payload: { kind: 'command', argv: ['/bin/bash', '/non/esiste.sh'], input: 'Leggi ~/a/b.md' }, delivery: { mode: 'announce', channel: 'whatsapp', to: '+39000' } };
  const g = graphForJob(job, { at: 1, end: 2, ms: 1, outcome: 'ok' }, { title: 'Prova', last: { delivered: 'delivered' } });
  assert.deepEqual(g.nodes.map((n) => n.kind), ['trigger', 'sources', 'step', 'deliver']);
  assert.equal(g.nodes.at(-1).label, 'WhatsApp');
  // Il numero di telefono del canale non esce mai dall'hub.
  assert.doesNotMatch(JSON.stringify(g), /\+39000/);
});

test('graphForJob agente: modello e ripieghi dalla definizione, il primo con l\'esito del giro', () => {
  const job = { id: 'y', name: 'agente', schedule: { kind: 'cron', expr: '0 9 * * 1' }, payload: { kind: 'agentTurn', message: 'Fai X', model: 'anthropic/claude-sonnet-5-5', fallbacks: ['muse-cli/muse-spark-1.3'] }, delivery: { mode: 'none' } };
  const g = graphForJob(job, { at: 1000, end: 61000, ms: 60000, outcome: 'ok' });
  const m = g.nodes.find((n) => n.kind === 'model');
  assert.deepEqual(m.options.map((o) => o.name + ':' + o.outcome), ['Claude:ok', 'Muse:null']);
  assert.ok(!g.nodes.some((n) => n.kind === 'deliver'));
});

test('graphForJob: ingresso e uscita del modello dal prompt e dal testo del giro', () => {
  const job = { id: 'z', name: 'agente', schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn', message: 'Fai il riepilogo', model: 'anthropic/claude-sonnet-5-5' }, delivery: { mode: 'announce', channel: 'whatsapp' } };
  const g = graphForJob(job, { at: 1000, end: 61000, ms: 60000, outcome: 'ok', output: 'Ecco il riepilogo', deliveryError: null });
  const m = g.nodes.find((n) => n.kind === 'model');
  assert.equal(m.io.in, 'Fai il riepilogo');
  assert.equal(m.io.out, 'Ecco il riepilogo');
  assert.equal(m.ms, 60000);
  const g2 = graphForJob(job, { at: 1000, end: null, ms: null, outcome: 'error', output: null });
  assert.equal(g2.nodes.find((n) => n.kind === 'model').io.out, null);
});
