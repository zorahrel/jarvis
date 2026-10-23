// Modello della scheda Automazioni: dalle fonti grezze alla vista. Puro.
import { fp } from './describe.mjs';
import { levelOf, fromFindings } from './levels.mjs';
import { stateFor } from './feedback.mjs';
import { AREAS, purposeOf } from './purpose.mjs';

const H = 3600000;

export const GROUPS = [
  { id: 'arriva', title: 'Ti arriva ciò che deve' },
  { id: 'dati', title: 'I dati sono al sicuro' },
  { id: 'quote', title: 'Le quote reggono' },
  { id: 'macchine', title: 'Mac e PC respirano' },
  { id: 'prodotti', title: 'I prodotti sono verificati' },
];

const LABELS = {
  openclaw: 'OpenClaw',
  launchd: 'Mac (launchd)',
  desktop: 'Claude desktop',
  workflows: 'Workflow',
  github: 'GitHub',
  pc: 'PC di casa',
  findings: 'Controllo di salute',
};

// «16/9 alle 8:47», ora di Roma.
function calWords(at) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(at))) p[x.type] = x.value;
  return `${p.day}/${p.month} alle ${p.hour}:${p.minute}`;
}

// Stessa formula della mappa vecchia: i voti già dati restano validi.
const fpOf = (desc, item) => fp(`${desc?.cosa || ''}|${desc?.tiScrive || ''}|${item.tech?.prompt || item.tech?.command || ''}`);

function cardFeedback(fb) {
  return { vote: fb.vote || null, changedSinceVote: !!fb.changedSinceVote, mute: fb.mute || null, open: (fb.open || []).length, notes: fb.notes || [] };
}

// Gli ultimi esiti per la barra di storico: le stesse fonti di last, ma solo esiti chiusi (niente «in corso»).
// Più recenti per primi. Le fonti portano fino a 10 giri, launchd e Claude desktop solo l'ultimo.
const HIST_MAX = 20;
const HIST_OUT = { ok: 'ok', error: 'error', interrupted: 'error', failed: 'error', timed_out: 'error', skipped: 'skipped', cancelled: 'skipped', neutral: 'skipped' };
const newestFirst = (xs) => xs.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, HIST_MAX);
export function historyOf(item) {
  const out = [];
  for (const r of item.runs || []) {
    const outcome = HIST_OUT[r?.outcome];
    if (outcome) out.push({ at: r.at ?? null, outcome });
  }
  return newestFirst(out);
}

// Giri delle ultime 24 ore per la striscia: [ora, esito] compatti. Dove la fonte non li ha, i giri noti.
export function dayOf(item) {
  const src = item.day || (item.runs || []).map((r) => [r?.at, r?.outcome]);
  return src.filter((r) => r[0] != null).map((r) => [r[0], HIST_OUT[r[1]] || 'running']);
}

// Token risparmiati rispetto a Claude: i token dei passi eseguiti da altri esecutori (free, muse, codex).
// È una stima: quei modelli consumano token propri, non gli stessi di Claude. Senza token noti, null.
export function savedTokens(steps) {
  const known = (steps || []).filter((s) => s.tokens != null);
  if (!known.length) return null;
  return known.filter((s) => s.executor && s.executor !== 'claude').reduce((n, s) => n + s.tokens, 0);
}

// Le fonti che non registrano un dato: così chi legge sa che il null è una mancanza, non un errore.
const MISSING = [
  'costo per passo: nessuna fonte (i token ci sono solo nei workflow di Claude Code)',
  'cron di OpenClaw: openclaw.sqlite non registra token né costi per giro (cron_run_receipts non ha usage)',
  'delega: le decisioni di :3360/api/route non vengono salvate, quindi l’esecutore dei cron non si sa',
  'Lobster: runs.jsonl registra solo lo stato dei passi, senza modello né token',
];

// Una card per un item solo.
function singleCard(ev) {
  const { item, desc, fpv, fb, proof, level, reason, since } = ev;
  return {
    key: item.key,
    provider: item.provider,
    title: desc?.titolo || item.name,
    cosa: desc?.cosa || '',
    means: desc?.tiScrive || '',
    who: item.who ?? null,
    reportsTo: item.reportsTo ?? null,
    when: item.when ?? null,
    next: item.next ?? null,
    nextApprox: !!item.nextApprox,
    last: item.last,
    history: historyOf(item),
    day: dayOf(item),
    purpose: purposeOf(item.key, desc, desc?.group),
    steps: item.steps ?? null,
    tokensSavedVsClaude: item.tokensSavedVsClaude ?? null,
    proof: proof || null,
    runsToday: item.runsToday ?? 0,
    group: desc?.group || null,
    level,
    reason,
    since: since ?? null,
    sources: [{ key: item.key, provider: item.provider, level, last: item.last }],
    tech: item.tech ?? null,
    feedback: cardFeedback(fb),
    fp: fpv,
    missing: !desc,
  };
}

// Più item con lo stesso oggetto: una card sola, col livello peggiore (o migliore con anyOk).
function fusedCard(name, members, descriptions) {
  const odesc = descriptions['object:' + name] || null;
  const rank = { te: 0, rotto: 1, va: 2 };
  const anyOk = !!(odesc?.anyOk || members.some((m) => m.desc?.anyOk));
  const ordered = [...members].sort((a, b) => rank[a.level] - rank[b.level]);
  const primary = anyOk ? ordered[ordered.length - 1] : ordered[0];
  const level = primary.level;
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    key: 'object:' + name,
    provider: primary.item.provider,
    title: odesc?.titolo || primary.item.name,
    cosa: odesc?.cosa || '',
    means: odesc?.tiScrive || '',
    who: uniq(members.map((m) => m.item.who)).join(', ') || null,
    reportsTo: uniq(members.map((m) => m.item.reportsTo)).join(', ') || null,
    when: primary.item.when ?? null,
    next: primary.item.next ?? null,
    nextApprox: !!primary.item.nextApprox,
    last: primary.item.last,
    history: newestFirst(members.flatMap((m) => historyOf(m.item))),
    day: members.flatMap((m) => dayOf(m.item)),
    purpose: purposeOf(`object:${name}`, odesc, odesc?.group),
    steps: null,
    tokensSavedVsClaude: null,
    proof: members.find((m) => m.proof && m.proof.ok === false)?.proof || members.find((m) => m.proof)?.proof || null,
    runsToday: members.reduce((s, m) => s + (m.item.runsToday || 0), 0),
    group: odesc?.group || null,
    level,
    reason: level === 'va' ? `vista da ${members.length} fonti` : primary.reason,
    since: primary.since ?? null,
    sources: members.map((m) => ({ key: m.item.key, provider: m.item.provider, level: m.level, last: m.item.last })),
    tech: primary.item.tech ?? null,
    feedback: {
      vote: null,
      changedSinceVote: members.some((m) => m.fb.changedSinceVote),
      mute: members.map((m) => m.fb.mute).find(Boolean) || null,
      open: members.reduce((s, m) => s + (m.fb.open || []).length, 0),
      notes: members.flatMap((m) => m.fb.notes || []),
    },
    fp: fpOf(odesc, primary.item),
    missing: !odesc,
  };
}

function causeCard(n) {
  const none = { vote: null, changedSinceVote: false, mute: null, open: 0, notes: [] };
  return {
    key: 'cause:openclaw', provider: 'openclaw', title: 'OpenClaw è fermo',
    cosa: '', means: '', who: 'OpenClaw', reportsTo: null, when: null,
    next: null, nextApprox: false,
    last: { at: null, outcome: null, delivered: null, error: null },
    proof: null, runsToday: 0, group: 'macchine', level: 'rotto',
    reason: `${n} automazioni sono in pausa finché non riparte`,
    since: null, sources: [],
    tech: { schedule: null, exit: null, command: null, prompt: null, label: null, url: null },
    feedback: none, fp: null, missing: false,
  };
}

function sourceCard(name, downSince) {
  const none = { vote: null, changedSinceVote: false, mute: null, open: 0, notes: [] };
  return {
    key: 'source:' + name, provider: name, title: `Non riesco a leggere ${LABELS[name] || name}`,
    cosa: '', means: '', who: null, reportsTo: null, when: null,
    next: null, nextApprox: false,
    last: { at: null, outcome: null, delivered: null, error: null },
    proof: null, runsToday: 0, group: 'macchine', level: 'te',
    reason: downSince != null ? `da ${calWords(downSince)}: finché non torna, quello che fa non lo vedi` : 'non lo leggo adesso: finché non torna, quello che fa non lo vedi',
    since: downSince ?? null, sources: [],
    tech: { schedule: null, exit: null, command: null, prompt: null, label: null, url: null },
    feedback: none, fp: null, missing: false,
  };
}

// Riga di cron-health senza un job dietro (heartbeat, doctor…): card propria, la chiave è la riga.
function healthCard(f) {
  const c = sourceCard('findings', null);
  return { ...c, key: f.key, provider: 'health', title: f.title, level: f.level, reason: f.reason, group: 'macchine' };
}

const RANK = { va: 0, rotto: 1, te: 2 };

const byAge = (a, b) => (a.since ?? Infinity) - (b.since ?? Infinity);

export function buildModel({ now, sources = {}, descriptions = {}, feedback = new Map(), findings = null, gateway = { up: true }, proofs = {} } = {}) {
  const descs = descriptions || {};
  const state = feedback || new Map();
  const prs = proofs || {};
  const gwDown = gateway && gateway.up === false;
  const pcAsleep = !!sources.pc?.asleep;
  const names = ['openclaw', 'launchd', 'desktop', 'workflows', 'github', 'pc'];
  const all = [];
  for (const n of names) for (const item of sources[n]?.items || []) all.push(item);

  // Il controllo di salute delle 8:45 alza il livello di un job (mai lo abbassa: il mute l'ha già tolto lui).
  const health = fromFindings(findings?.items || [], all);
  const hidden = [];
  const singles = [];
  const objects = new Map();
  let openclawCount = 0;
  for (const item of all) {
    if (item.provider === 'openclaw') openclawCount++;
    const desc = descs[item.key] || null;
    const fpv = fpOf(desc, item);
    const fb = stateFor(state, item.key, fpv);
    const proof = prs[item.key] || null;
    let ev = { item, desc, fpv, fb, proof, ...levelOf(item, { now, desc, fb, proof }) };
    const hf = health.byKey.get(item.key);
    if (hf && ev.level in RANK && RANK[hf.level] > RANK[ev.level]) ev = { ...ev, level: hf.level, reason: hf.reason };
    if (gwDown && item.provider === 'openclaw') {
      ev = { ...ev, level: 'nascosto', reason: 'in pausa finché non riparte OpenClaw', since: null };
    }
    // I workflow non avvisano mai: stanno nella sezione apposita, non in card.
    if (ev.item.provider === 'workflow') continue;
    if (ev.item.provider === 'lobster' && !ev.item.waitingApproval) continue;
    // PC che dorme: nessuna card, solo la nota nel piede.
    if (pcAsleep && ev.item.provider === 'pc') continue;
    if (ev.level === 'nascosto') {
      hidden.push({ title: desc?.titolo || item.name, reason: ev.reason });
      continue;
    }
    if (desc?.object) {
      if (!objects.has(desc.object)) objects.set(desc.object, []);
      objects.get(desc.object).push(ev);
      continue;
    }
    singles.push(singleCard(ev));
  }
  const cards = [...singles];
  for (const [name, members] of objects) cards.push(fusedCard(name, members, descs));

  const needsYou = [];
  const broken = [];
  const okCards = [];
  for (const c of cards) {
    if (c.level === 'te') needsYou.push(c);
    else if (c.level === 'rotto') broken.push(c);
    else okCards.push(c);
  }
  if (gwDown) broken.push(causeCard(openclawCount));
  for (const f of health.loose) (f.level === 'te' ? needsYou : broken).push(healthCard(f));
  for (const n of names) {
    const s = sources[n] || {};
    if (s.ok === false && !s.pending && s.downSince != null && now - s.downSince > 2 * H) {
      needsYou.push(sourceCard(n, s.downSince));
    }
  }
  needsYou.sort(byAge);
  broken.sort(byAge);
  const groups = GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    cards: okCards.filter((c) => (c.group || 'macchine') === g.id).sort((a, b) => a.title.localeCompare(b.title, 'it')),
  }));
  // Workflow: ultime corse, per nome.
  const wruns = [...(sources.workflows?.runs || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
  const byName = new Map();
  for (const r of wruns) {
    if (!r.name) continue;
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  const wfByName = [...byName.entries()]
    .map(([name, rs]) => ({
      name,
      total: rs.length,
      failed: rs.filter((r) => r.status === 'error').length,
      last: rs.reduce((m, r) => Math.max(m, r.at || 0), 0) || null,
      runs: rs.map((r) => ({
        runId: r.runId, at: r.at, outcome: r.status,
        durationMs: r.durationMs ?? null, agents: r.agents ?? null,
        phases: r.phases ?? [], summary: r.summary ?? null,
        steps: r.steps ?? [], tokensSavedVsClaude: savedTokens(r.steps),
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const workflows = {
    days: 7,
    total: wruns.length,
    failed: wruns.filter((r) => r.status === 'error').length,
    byName: wfByName,
  };
  const ordered = [...needsYou, ...broken, ...groups.flatMap((g) => g.cards)];
  const review = { total: ordered.length, unconfirmed: ordered.filter((c) => !c.feedback.vote).map((c) => c.key) };
  const verdict = {
    needsYou: needsYou.length,
    broken: broken.length,
    ok: okCards.length,
    hidden: hidden.length,
    runsToday: all.reduce((s, it) => s + (it.runsToday || 0), 0),
  };
  const footerSources = names.map((n) => {
    const s = sources[n] || {};
    if (n === 'pc' && s.asleep) {
      return { name: n, label: LABELS[n], ok: true, at: s.at ?? null, pending: false, note: 'PC dorme' };
    }
    return { name: n, label: LABELS[n], ok: !!s.ok, at: s.at ?? null, pending: !!s.pending, note: s.ok ? null : '?' };
  });
  footerSources.push({
    name: 'findings', label: LABELS.findings, ok: findings != null,
    at: findings?.at ?? null, pending: false, note: findings != null ? null : '?',
  });
  const footer = {
    sources: footerSources,
    pcAsleep: !!sources.pc?.asleep,
    hidden: { count: hidden.length, why: hidden },
    counts: sources.counted?.counts ?? null,
  };
  const byKey = {};
  for (const c of ordered) byKey[c.key] = c;
  const areas = AREAS.map((a) => ({ ...a, count: ordered.filter((c) => c.purpose?.area === a.id).length }));
  return { checkedAt: now, verdict, needsYou, broken, groups, workflows, review, footer, areas, missing: MISSING, cards: byKey };
}
