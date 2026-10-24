import '../test-support/isolate-tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextReport } from '../src/context.mjs';

const NOW = Date.UTC(2026, 9, 24, 12); // 24/10/2026
const SHARED = 'Questa regola molto lunga compare identica in due file diversi del sistema';
const PHONE = 'Il numero di prova da non mostrare mai e +39 333 000 0000 resta sempre fuori';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-home-'));
const w = (rel, text) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

w('.claude/CLAUDE.md', [
  '# Titolo',
  '@~/.claude/tools/TOOLS.md',
  `- **${SHARED}**`,
  `- ${PHONE}`,
  '- Vecchia regola di prova decisa tempo fa e mai più rivista da nessuno (01/01)',
  '- Regola fresca di prova decisa da poco e ancora attuale per tutti (21/10)',
  '```',
  'riga dentro il blocco con data 01/01 che non deve contare per niente qui',
  '```',
].join('\n'));
w('.claude/tools/TOOLS.md', 'Strumenti di prova\n');
w('.agents/AGENTS.md', `${SHARED}\n${PHONE}\n`);
w('.claude/settings.json', JSON.stringify({ outputStyle: 'Attention-kind' }));
w('.claude/output-styles/attention-kind.md', 'stile di prova\n');
w('.openclaw/openclaw.json', JSON.stringify({
  agents: { defaults: { workspace: path.join(home, '.openclaw'), heartbeat: { prompt: 'Controlla la posta di prova' } } },
}));
fs.mkdirSync(path.join(home, '.openclaw/agents/main'), { recursive: true });
w('.openclaw/AGENTS.md', `${SHARED}\n${PHONE}\n`);
w('.openclaw/SOUL.md', 'anima di prova\n');
w('.agents/skills/uno/SKILL.md', '---\nname: uno\ndescription: "Prima skill di prova"\n---\ncorpo\n');
w('.agents/skills/due/SKILL.md', '---\nname: due\ndescription: >\n  Seconda skill\n  su più righe\n---\ncorpo\n');

const okDoctor = async () => ({ code: 0, stdout: 'ok   x\n' });
const rep = await contextReport({ home, now: NOW, runDoctor: okDoctor });
const byId = (id) => rep.files.find((f) => f.id === id);

test('file elencati con i loro legami', () => {
  for (const id of ['claude-md', 'inc:tools.md', 'agents-md', 'style', 'oc:main:AGENTS.md', 'oc:main:SOUL.md', 'oc:heartbeat']) {
    assert.ok(byId(id), id);
  }
  assert.equal(byId('inc:tools.md').includedBy, 'claude-md');
  assert.deepEqual(byId('agents-md').generatedFrom, ['claude-md', 'inc:tools.md']);
  assert.equal(byId('memory-index'), undefined); // assente = fuori, senza errori
});

test('tokens e percorsi', () => {
  for (const f of rep.files) assert.equal(f.tokens, Math.ceil(f.chars / 4), f.id);
  for (const f of rep.files.filter((x) => x.id !== 'oc:heartbeat')) assert.ok(f.path.startsWith('~/'), f.path);
  assert.equal(byId('oc:heartbeat').chars, 'Controlla la posta di prova'.length);
});

test('doppioni: agents-md escluso, telefono mascherato', () => {
  const d = rep.duplicates.find((x) => x.text.includes('Questa regola'));
  assert.ok(d);
  assert.deepEqual(d.files.sort(), ['claude-md', 'oc:main:AGENTS.md']);
  const p = rep.duplicates.find((x) => x.text.includes('numero di prova'));
  assert.ok(p);
  assert.ok(!p.text.includes('333'));
  assert.ok(p.text.includes('…'));
});

test('regole con date vecchie', () => {
  const old = rep.oldRules.find((r) => r.text.includes('Vecchia regola'));
  assert.ok(old && old.days > 45);
  assert.equal(old.date, '2026-01-01');
  assert.equal(old.file, 'claude-md');
  assert.ok(!rep.oldRules.some((r) => r.text.includes('fresca')));
  assert.ok(!rep.oldRules.some((r) => r.text.includes('dentro il blocco')));
});

test('skill nel listing', () => {
  assert.equal(rep.skills.count, 2);
  const due = rep.skills.items.find((s) => s.name === 'due');
  assert.equal(due.chars, 'due'.length + 'Seconda skill su più righe'.length + 4);
  assert.equal(rep.skills.tokens, rep.skills.items.reduce((a, s) => a + s.tokens, 0));
  assert.ok(rep.totals.byLoader['OpenClaw · main'] >= rep.skills.tokens);
});

test('doctor', async () => {
  const bad = await contextReport({ home, now: NOW, runDoctor: async () => ({ code: 1, stdout: 'ok   a\nFAIL b\n' }) });
  assert.equal(bad.doctor.ok, false);
  assert.equal(bad.doctor.checks.length, 2);
  assert.equal(bad.doctor.checks[1].ok, false);
  const gone = await contextReport({ home, now: NOW, runDoctor: async () => ({ code: 127, stdout: '', error: 'non trovato' }) });
  assert.equal(gone.doctor.ok, false);
  assert.equal(gone.doctor.error, 'non trovato');
  assert.equal(rep.doctor.ok, true);
});
