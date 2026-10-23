// Copiato da automazioni-map.mjs il 23/10, quel file ora importa da qui.
import os from 'node:os';

const HOME = os.homedir();
export const tilde = (s) => String(s ?? '').replace(new RegExp(HOME, 'g'), '~');

export const DAYS = { '1-5': 'lun-ven', '*': 'ogni giorno', 1: 'il lunedì', 2: 'il martedì', 3: 'il mercoledì', 4: 'il giovedì', 5: 'il venerdì', 6: 'il sabato', 0: 'la domenica', 7: 'la domenica' };
export const SHORT = { 0: 'dom', 1: 'lun', 2: 'mar', 3: 'mer', 4: 'gio', 5: 'ven', 6: 'sab', 7: 'dom' };
export function whenOf(s) {
  if (!s) return '—';
  if (s.kind === 'every') {
    const m = Math.round(s.everyMs / 60000);
    return m >= 60 && m % 60 === 0 ? `ogni ${m / 60 === 1 ? 'ora' : `${m / 60} ore`}` : `ogni ${m} min`;
  }
  if (s.kind === 'at') return new Date(s.at).toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const [mi, h, dom, , dow] = (s.expr || '').split(/\s+/);
  const hours = (h || '').split(',').map((x) => `${x}:${mi.padStart(2, '0')}`).join(' e ');
  if (dom !== '*' && dom) return `il ${dom} del mese alle ${hours}`;
  return `${DAYS[dow] ?? dow} alle ${hours}`;
}

export function condOf(j) {
  const m = /cron-when: ([^\n]+)/.exec(j.trigger?.script || '');
  if (!m) return j.trigger ? 'solo se lo script di controllo dice sì' : null;
  return m[1].replace(/--idle (\d+)/, 'Mac fermo da $1 s').replace(/--hours (\S+)/, 'fra le $1').replace(/--unless-file \S+\/([^/\s]+)/, 'finché non esiste $1')
    .replace(/--free/, 'abbonamento libero').replace(/--deadline (\S+)/, 'entro $1');
}

export const MODEL = (ref) => (!ref ? null : ref.startsWith('muse') ? 'Muse' : ref.startsWith('openai') ? 'Codex' : ref.includes('opus') ? 'Claude Opus' : ref.includes('haiku') ? 'Claude Haiku' : 'Claude Sonnet');
export function whoOf(j) {
  const p = j.payload || {};
  if (p.kind === 'heartbeat') return { who: 'Jarvis nella chat principale', ai: true };
  if (p.kind === 'command') {
    const cmd = tilde((p.argv || []).join(' ')).replace(/^sh -lc /, '');
    const parts = cmd.split(' ');
    const file = parts.find((x) => /[\w-]+\.(mjs|js|py|sh)$/.test(x)) || parts.find((x) => /\/bin\/[\w-]+$/.test(x) && !/\/(python3?|node|sh|bash|zsh)$/.test(x));
    return { who: `script: ${file?.split('/').pop() || cmd.slice(0, 40)}`, ai: false, cmd };
  }
  const chain = [p.model, ...(p.fallbacks || [])].map(MODEL).filter(Boolean);
  const uniq = [...new Set(chain)];
  return { who: uniq.length ? `${uniq[0]}${uniq.length > 1 ? `, poi ${uniq.slice(1).join(', ')}` : ''}` : 'modello predefinito', ai: true };
}

export const CH = { whatsapp: 'WhatsApp', discord: 'Discord', telegram: 'Telegram', last: "l'ultima chat" };
export function outOf(j) {
  const d = j.delivery;
  if (j.payload?.kind === 'heartbeat') return 'la tua chat, solo se c\'è qualcosa';
  if (!d || d.mode === 'none') return 'nessun messaggio';
  return `${CH[d.channel] || d.channel || 'chat'}${d.mode === 'announce' ? '' : ` (${d.mode})`}`;
}

export const promptOf = (j) => tilde(j.payload?.message || j.payload?.input || (j.payload?.argv || []).join(' ') || '');

// Impronta di ciò che Attilio conferma: se descrizione o prompt cambiano, la conferma vecchia non vale più.
export const fp = (s) => { let h = 5381; for (const c of String(s)) h = ((h << 5) + h + c.codePointAt(0)) >>> 0; return h.toString(36); };

// Quando gira, per il disegno della giornata: orari fissi (minuti dal mezzanotte) con i giorni,
// oppure «di continuo» con l'intervallo e l'eventuale fascia oraria della condizione.
export function timesOfCron(schedule, cond) {
  if (schedule?.kind === 'every') {
    const band = /fra le (\d+)-(\d+)/.exec(cond || '');
    return { every: Math.round(schedule.everyMs / 60000), band: band ? [+band[1], +band[2]] : null };
  }
  if (schedule?.kind !== 'cron') return null;
  const [mi, h, dom, , dow] = (schedule.expr || '').split(/\s+/);
  if (!/^\d+$/.test(mi) || !/^[\d,]+$/.test(h)) return null;
  const days = dom !== '*' ? `il ${dom} del mese` : dow === '*' ? '' : dow === '1-5' ? 'lun-ven' : dow.split(',').map((d) => SHORT[d] ?? d).join(', ');
  return { at: h.split(',').map((x) => +x * 60 + +mi), days };
}
export function timesOfLaunchd(p) {
  if (p.StartInterval) return { every: Math.round(p.StartInterval / 60) };
  const cal = [].concat(p.StartCalendarInterval || []);
  if (!cal.length) return null;
  if (cal.every((c) => c.Hour == null)) return { every: 60, minute: cal[0].Minute ?? 0 };
  const at = [...new Set(cal.map((c) => c.Hour * 60 + (c.Minute ?? 0)))].sort((a, b) => a - b);
  const wd = [...new Set(cal.map((c) => c.Weekday).filter((w) => w != null))].sort();
  const days = !wd.length ? '' : wd.join(',') === '1,2,3,4,5' ? 'lun-ven' : wd.map((d) => SHORT[d]).join(', ');
  return { at, days };
}
