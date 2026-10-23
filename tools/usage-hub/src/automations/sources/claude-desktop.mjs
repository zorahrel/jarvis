// Task schedulati dell'app desktop Claude: file locali, lettura sincrona.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (now, error) => ({ ok: false, at: now, items: [], error });

// Tra due copie dello stesso id vince lastRunAt più recente; senza lastRunAt, createdAt più recente.
function wins(a, b) {
  const al = a.lastRunAt ? Date.parse(a.lastRunAt) : NaN;
  const bl = b.lastRunAt ? Date.parse(b.lastRunAt) : NaN;
  if (!Number.isNaN(al) || !Number.isNaN(bl)) return (Number.isNaN(al) ? -1 : al) > (Number.isNaN(bl) ? -1 : bl);
  return (Number(a.createdAt) || 0) > (Number(b.createdAt) || 0);
}

// Corpo della SKILL senza frontmatter: il frontmatter descrive, il corpo istruisce.
function promptFor(skillsDir, id) {
  let s;
  try { s = fs.readFileSync(path.join(skillsDir, id, 'SKILL.md'), 'utf8'); } catch { return null; }
  return s.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function toItem(t, skillsDir, now) {
  const fireAt = typeof t.fireAt === 'number' ? t.fireAt : Date.parse(t.fireAt);
  const fire = Number.isFinite(fireAt) ? fireAt : null;
  const lastMs = t.lastRunAt == null
    ? null
    : (typeof t.lastRunAt === 'number' ? t.lastRunAt : Date.parse(t.lastRunAt) || null);
  return {
    key: 'desktop:' + t.id,
    provider: 'desktop',
    name: t.displayName || t.id,
    enabled: t.enabled !== false,
    everyMs: null, // oggi solo task a data; un eventuale cronExpression resta in tech.schedule
    when: fire != null
      ? new Date(fire).toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : (t.cronExpression || null),
    next: fire != null && fire > now ? fire : null,
    nextApprox: false,
    expectedLast: null,
    last: { at: lastMs, outcome: t.lastRunAt ? 'ok' : null, delivered: null, error: null },
    runs: lastMs ? [{ at: lastMs, outcome: 'ok' }] : [],
    consecutiveErrors: 0,
    runsToday: 0,
    who: 'Claude (app desktop)',
    reportsTo: t.notifySessionId ? "la sessione che l'ha creato" : 'nessun messaggio',
    fireAt: fire,
    neverRan: !t.lastRunAt,
    tech: {
      schedule: t.cronExpression || (fire != null ? new Date(fire).toISOString() : null),
      exit: null,
      command: t.cwd || null,
      prompt: promptFor(skillsDir, t.id),
      label: t.id,
      url: null,
    },
  };
}

export function readDesktop({ bases, skillsDir, now = Date.now() } = {}) {
  const home = os.homedir();
  bases ??= [
    path.join(home, 'Library/Application Support/Claude/claude-code-sessions'),
    path.join(home, 'Library/Application Support/Claude/local-agent-mode-sessions'),
  ];
  skillsDir ??= path.join(home, '.claude/scheduled-tasks');
  const byId = new Map();
  for (const base of bases) {
    let l1;
    try { l1 = fs.readdirSync(base); } catch { continue; } // base assente: si salta
    for (const a of l1) {
      let l2;
      try { l2 = fs.readdirSync(path.join(base, a)); } catch { continue; }
      for (const b of l2) {
        const f = path.join(base, a, b, 'scheduled-tasks.json');
        if (!fs.existsSync(f)) continue;
        let j;
        try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fail(now, f + ': JSON illeggibile'); }
        for (const t of j.scheduledTasks || []) {
          if (!t || !t.id) continue;
          const prev = byId.get(t.id);
          if (!prev || wins(t, prev)) byId.set(t.id, t);
        }
      }
    }
  }
  const items = [...byId.values()].map((t) => toItem(t, skillsDir, now)).sort((a, b) => (a.fireAt || 0) - (b.fireAt || 0));
  return { ok: true, at: now, items };
}
