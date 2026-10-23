import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceForModel } from './api-prices.mjs';

export const API_SPEND_FILE = process.env.VDM_API_SPEND_FILE ||
  path.join(process.env.VDM_STATE_DIR || path.dirname(fileURLToPath(import.meta.url)), 'api-spend.json');

const DAY_FORMAT = new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
});
const SINCE_DAY = '2026-10-16';

function millis(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) throw new TypeError('now must be a valid Date or timestamp');
  return value;
}

function dayKey(now) {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(new Date(millis(now)))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDay(day, offset) {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + offset));
  return shifted.toISOString().slice(0, 10);
}

function emptyData() { return { version: 1, days: {} }; }

function readData(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data?.version === 1 && data.days && typeof data.days === 'object' && !Array.isArray(data.days)) return data;
  } catch {}
  return emptyData();
}

function tokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function recordRow(data, day, keyName, model, usage) {
  const dayBucket = data.days[day] ??= {};
  const keyBucket = dayBucket[keyName] ??= {};
  const row = keyBucket[model] ??= {
    input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, estimated: false,
  };
  for (const field of ['input', 'output', 'cacheWrite', 'cacheRead']) {
    row[field] = tokenCount(row[field]) + usage[field];
  }
  const price = priceForModel(model);
  if (price) {
    row.cost = round(Number(row.cost || 0) + (
      usage.input * price.input + usage.output * price.output +
      usage.cacheWrite * price.cacheWrite5m + usage.cacheRead * price.cacheRead
    ) / 1_000_000, 10);
    row.estimated = true;
  } else {
    row.cost = 0;
    row.estimated = false;
  }
}

export function recordApiSpend({ keyName, model, usage = {}, now = Date.now(), file = API_SPEND_FILE } = {}) {
  if (typeof model !== 'string' || !model.trim()) return false;
  const key = String(keyName || 'unknown').slice(0, 48);
  const name = model.trim().slice(0, 128);
  const counts = {
    input: tokenCount(usage.input), output: tokenCount(usage.output),
    cacheWrite: tokenCount(usage.cacheWrite), cacheRead: tokenCount(usage.cacheRead),
  };
  if (!Object.values(counts).some(Boolean)) return false;

  const today = dayKey(now);
  const data = readData(file);
  recordRow(data, today, key, name, counts);
  const cutoff = shiftDay(today, -90);
  for (const day of Object.keys(data.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff) delete data.days[day];
  }

  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

export function formatApiSpendLine(summary) {
  const amount = value => Number(value || 0).toFixed(2);
  // Le voci per chiave sono sempre finestre 7d, così quadrano col totale.
  const keys = Object.entries(summary?.perKey || {}).map(([key, row]) => `${key} $${amount(row.last7d)}`).join(', ');
  const warning = Number(summary?.last7d || 0) > 20 ? ' ⚠️' : '';
  return `API Claude: $${amount(summary?.today)} oggi · $${amount(summary?.last7d)} 7g${keys ? ` (${keys})` : ''}${warning}`;
}

export function spendSummary({ now = Date.now(), file = API_SPEND_FILE } = {}) {
  const todayKey = dayKey(now);
  const weekStart = shiftDay(todayKey, -6);
  const data = readData(file);
  const totals = { today: 0, last7d: 0, sinceOct16: 0 };
  const perKey = {};
  const modelRows = {};

  for (const [day, keys] of Object.entries(data.days)) {
    if (day > todayKey) continue;
    for (const [key, models] of Object.entries(keys || {})) {
      const cost = Object.values(models || {}).reduce((sum, row) => sum + Number(row?.cost || 0), 0);
      const entry = perKey[key] ??= { today: 0, last7d: 0, sinceOct16: 0 };
      if (day >= SINCE_DAY) { entry.sinceOct16 += cost; totals.sinceOct16 += cost; }
      if (day === todayKey) { entry.today += cost; totals.today += cost; }
      if (day >= weekStart) {
        entry.last7d += cost; totals.last7d += cost;
        for (const [model, row] of Object.entries(models || {})) {
          const m = (modelRows[`${key}|${model}`] ??= { key, model, last7d: 0, tokens: 0, estimated: true });
          m.last7d += Number(row?.cost || 0);
          m.tokens += tokenCount(row?.input) + tokenCount(row?.output) + tokenCount(row?.cacheWrite) + tokenCount(row?.cacheRead);
          if (!row?.estimated) m.estimated = false;
        }
      }
    }
  }

  const keys = Object.fromEntries(Object.entries(perKey).map(([key, amounts]) => [key, {
    today: round(amounts.today, 4), last7d: round(amounts.last7d, 4), sinceOct16: round(amounts.sinceOct16, 4),
  }]));
  // I totali sono la somma delle righe già arrotondate: le chiavi quadrano col totale al centesimo di millesimo.
  const sumOf = field => round(Object.values(keys).reduce((sum, row) => sum + row[field], 0), 4);
  const summary = {
    currency: 'USD',
    today: sumOf('today'),
    last7d: sumOf('last7d'),
    sinceOct16: sumOf('sinceOct16'),
    perKey: keys,
    perKeyModel: modelRows,
  };
  summary.perKeyModel = Object.values(summary.perKeyModel).map(m => ({ ...m, last7d: round(m.last7d, 4) }))
    .sort((a, b) => b.last7d - a.last7d);
  summary.line = formatApiSpendLine(summary);
  return summary;
}
