// Automazioni finte per `serve --demo`: un modello fisso (ok o problemi) spostato ad adesso, con sopra il feedback vero
// di una cartella di prova. Servono a screenshot, video e test: nessun nome vero, nessuna fonte letta.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll, buildState, stateFor, append, openItems } from './feedback.mjs';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '../../test/fixtures/automations');
const TIME_KEYS = new Set(['checkedAt', 'at', 'next', 'since', 'fireAt', 'expectedLast']);

// Le date della fixture si spostano tutte dello stesso scarto: «stanotte alle 4:32» resta stanotte.
function shift(v, d) {
  if (Array.isArray(v)) return v.map((x) => shift(x, d));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, TIME_KEYS.has(k) && typeof x === 'number' && x > 1.7e12 ? x + d : shift(x, d)]));
}

export function createDemoAutomations({ fixture = 'ok', dir = process.env.USAGE_HUB_FEEDBACK_DIR, now = () => Date.now() } = {}) {
  const fbDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hub-demo-feedback-'));
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, `model-${fixture}.json`), 'utf8'));
  // Mezzanotte allineata: lo scarto è un multiplo di 24 h, così gli orari della fixture restano gli stessi.
  const delta = Math.round((now() - base.checkedAt) / 86400000) * 86400000;
  const model = async () => {
    const m = shift(base, delta);
    m.checkedAt = now();
    const state = buildState(readAll({ dir: fbDir }).rows, { now: now() });
    for (const c of Object.values(m.cards || {})) {
      const fb = stateFor(state, c.key, c.fp);
      c.feedback = { vote: fb.vote, changedSinceVote: fb.changedSinceVote, mute: fb.mute, open: fb.open.length, notes: fb.notes };
    }
    // le sezioni portano copie delle card: si rimettono quelle aggiornate
    const fresh = (c) => m.cards[c.key] || c;
    m.needsYou = m.needsYou.map(fresh); m.broken = m.broken.map(fresh);
    for (const g of m.groups) g.cards = g.cards.map(fresh);
    m.review = { ...m.review, unconfirmed: Object.values(m.cards).filter((c) => !c.feedback.vote).map((c) => c.key) };
    m.feedbackOpen = openItems(state).length;
    return m;
  };
  return {
    model,
    summary: async () => { const m = await model(); return { ...m.verdict, checkedAt: m.checkedAt, sources: m.footer.sources.map((s) => ({ name: s.name, ok: s.ok, at: s.at, pending: !!s.pending })) }; },
    feedback: (row) => append(row, { dir: fbDir }),
    openFeedback: () => openItems(buildState(readAll({ dir: fbDir }).rows, { now: now() })),
    dir: fbDir,
  };
}
