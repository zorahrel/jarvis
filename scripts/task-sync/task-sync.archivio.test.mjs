// Una card collegata e archiviata deve uscire da read() come «done»: il GET della singola card non lo dice,
// e il 24/10 35 promemoria di card archiviate restavano aperti.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { topicsSide } from './task-sync.mjs';

test('le card archiviate collegate si leggono come done', async () => {
  const live = { id: 'L', projectId: 'b', text: 'viva', status: 'backlog' };
  const arch = { id: 'A', projectId: 'b', text: 'archiviata', status: 'backlog' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body;
    if (u.pathname === '/api/boards/b/tasks') body = { tasks: u.searchParams.get('archived') === '1' ? [arch] : [live] };
    else if (u.pathname === '/api/all-boards/tasks') body = { tasks: [] };
    else if (u.pathname === '/api/all-boards/tasks/A') body = { task: arch };
    else { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { cards } = await topicsSide({ base: `http://127.0.0.1:${srv.address().port}` }).read('b', ['L', 'A']);
    const cls = Object.fromEntries(cards.map((c) => [c.id, c.cls]));
    assert.deepEqual(cls, { L: 'open', A: 'done' });
  } finally { srv.close(); }
});
