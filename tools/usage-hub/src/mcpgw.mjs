// Il gateway MCP (mcp-hot-gateway, launchd com.jarvis.gateway) visto da fuori: quali server figli ha, il loro pid,
// le chiamate in corso, e il rimontaggio. Serve al freno del Mac: il 24/10 wigolo era a 5,9 GB dopo 15 giorni di vita,
// e rimontarlo lo ha riportato a 0,2 GB. Il client è il minimo del protocollo MCP su HTTP (initialize → una chiamata → chiusura).
const URL_DEFAULT = `http://127.0.0.1:${process.env.GATEWAY_HTTP_PORT || 23371}/mcp`;

async function body(res) {
  const t = await res.text();
  if (!(res.headers.get('content-type') || '').includes('event-stream')) return t ? JSON.parse(t) : null;
  const data = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  return data.length ? JSON.parse(data[data.length - 1]) : null;
}

export async function callGateway(tool, args = {}, { url = URL_DEFAULT, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetchImpl(url, { method: 'POST', headers: h, signal, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'usage-hub', version: '1' } } }) });
  if (!init.ok) throw new Error(`gateway MCP: initialize ${init.status}`);
  await body(init);
  const sid = init.headers.get('mcp-session-id');
  const hs = { ...h, ...(sid ? { 'mcp-session-id': sid } : {}) };
  try {
    await fetchImpl(url, { method: 'POST', headers: hs, signal, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const r = await fetchImpl(url, { method: 'POST', headers: hs, signal, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) });
    const j = await body(r);
    if (j?.error) throw new Error(j.error.message);
    const text = (j?.result?.content || []).map((c) => c.text || '').join('');
    if (j?.result?.isError) throw new Error(text || 'errore del gateway');
    return text;
  } finally {
    if (sid) fetchImpl(url, { method: 'DELETE', headers: hs }).catch(() => {});
  }
}

// [{ name, pid, inFlight, mounted }] dei figli montati con un processo proprio (stdio)
export async function mcpChildren(opts) {
  const j = JSON.parse(await callGateway('gateway_list', {}, opts));
  return (j.children || []).filter((c) => c.mounted && c.pid).map((c) => ({ name: c.name, pid: c.pid, inFlight: c.stats?.inFlight || 0 }));
}
export const remountMcp = (name, opts) => callGateway('gateway_mount', { name }, opts);
