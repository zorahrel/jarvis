// VDM legge budget e blocchi dall'hub (GET /api/policy), non da una copia sua.
// Fuori servizio l'hub non blocca niente: ritorna la lista vuota.
export async function fetchHubBlocks(hubUrl = 'http://127.0.0.1:3360', fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${hubUrl}/api/policy`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const { firing = [] } = await res.json();
    return firing.filter((f) => f.action === 'block').map((f) => f.project);
  } catch { return []; }
}
