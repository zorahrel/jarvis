// Legge la quota dell'account attivo: dalla tray (/api/overview) oppure da valori manuali.
export function pickClaudeAccount(overview) {
  const claude = (overview.providers || []).find((p) => p.id === 'claude');
  const acc = claude && (claude.accounts || []).find((a) => a.active);
  if (!acc) throw new Error('no active Claude account in overview');
  const q = (key) => (acc.quotas || []).find((x) => x.key === key);
  const week = q('7d');
  if (!week) throw new Error('no 7d quota in overview');
  const five = q('5h');
  return {
    label: acc.label || acc.id,
    weekPct: week.usedPct,
    weekResetsAt: week.resetsAt * 1000,
    fiveHourPct: five ? five.usedPct : null,
    fiveHourResetsAt: five ? five.resetsAt * 1000 : null,
  };
}

export async function getQuota(source = {}, fetchImpl = fetch) {
  if (source.type === 'manual') {
    return {
      label: source.label || 'manual',
      weekPct: source.weekPct,
      weekResetsAt: source.weekResetsAt,
      fiveHourPct: source.fiveHourPct ?? null,
      fiveHourResetsAt: null,
    };
  }
  const url = source.url || 'http://127.0.0.1:3360/api/overview';
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`quota source ${url} answered ${res.status}`);
  return pickClaudeAccount(await res.json());
}

// Quota Muse dalla stessa overview della tray (provider id 'muse').
// Ritorna null invece di lanciare: la dashboard resta viva senza Muse.
export function pickMuseQuota(overview) {
  const muse = (overview.providers || []).find((p) => p.id === 'muse');
  const acc = muse && (muse.accounts || []).find((a) => (a.quotas || []).length);
  if (!acc) return null;
  const q = (key) => (acc.quotas || []).find((x) => x.key === key);
  const week = q('7d');
  if (!week) return null;
  const five = q('5h');
  return {
    label: acc.label || acc.id,
    weekPct: week.usedPct,
    weekResetsAt: week.resetsAt ? week.resetsAt * 1000 : null,
    fiveHourPct: five ? five.usedPct : null,
    fiveHourResetsAt: five && five.resetsAt ? five.resetsAt * 1000 : null,
  };
}

export async function getMuseQuota(source = {}, fetchImpl = fetch) {
  if (source.type === 'manual') return null;
  const url = source.url || 'http://127.0.0.1:3360/api/overview';
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  try {
    return pickMuseQuota(await res.json());
  } catch {
    return null;
  }
}

// Quota Codex dalla stessa overview (provider id 'codex'); null se non leggibile.
export function pickCodexQuota(overview) {
  const codex = (overview.providers || []).find((p) => p.id === 'codex');
  const acc = codex && (codex.accounts || []).find((a) => (a.quotas || []).some((x) => x.key === '7d'));
  if (!acc) return null;
  const week = acc.quotas.find((x) => x.key === '7d');
  return { label: acc.label || acc.id, weekPct: week.usedPct, weekResetsAt: week.resetsAt ? week.resetsAt * 1000 : null };
}

export async function getCodexQuota(source = {}, fetchImpl = fetch) {
  if (source.type === 'manual') return null;
  const url = source.url || 'http://127.0.0.1:3360/api/overview';
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
    return res.ok ? pickCodexQuota(await res.json()) : null;
  } catch { return null; }
}
