import '../../../test-support/isolate-tmp.mjs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApiHeaders, routeApiFallback, safeApiProfiles, isOAuthPotentiallySelectable } from '../api-accounts.mjs';

describe('Anthropic API account fallback', () => {
  let server;
  let origin;
  const requests = [];

  before(async () => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        if (req.headers['x-api-key'] === 'test-key-high') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'credit balance unavailable' } }));
          return;
        }
        if (req.headers['anthropic-workspace-id'] === 'workspace-rejected') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'workspace is not authorized' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end('event: message_start\ndata: {"type":"message_start"}\n\n');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

  it('replays the exact buffered body, rotates by priority on billing failure, and uses API headers', async () => {
    requests.length = 0;
    const originalBody = Buffer.from(JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 71, stream: true, system: 'preserve me' }));
    const sent = [];
    const accounts = [
      { name: 'low', label: 'Lower', service: 'vdm-test', account: 'low', priority: 2, workspaceId: 'workspace-low' },
      { name: 'high', label: 'Higher', service: 'vdm-test', account: 'high', priority: 20, workspaceId: 'workspace-high' },
    ];
    const handled = await routeApiFallback({
      method: 'POST', path: '/v1/messages?trace=1', body: originalBody,
      headers: {
        authorization: 'Bearer oauth-placeholder', 'x-api-key': 'tok-finto',
        'anthropic-beta': 'oauth-2025-04-20, prompt-caching-2024-07-31',
        'anthropic-workspace-id': 'wrong-workspace', 'anthropic-version': '2023-06-01',
        'user-agent': 'Claude Code integration test', 'content-type': 'application/json',
      },
      accounts,
      secret: account => account.name === 'high' ? 'test-key-high' : 'test-key-low',
      request: async (method, path, headers, body) => {
        const response = await fetch(new URL(path, origin), { method, headers, body });
        return { status: response.status, headers: Object.fromEntries(response.headers), stream: response.body };
      },
      send: (status, headers, responseBody) => sent.push({ status, headers, body: responseBody }),
    });

    assert.equal(handled, true);
    assert.deepEqual(requests.map(item => item.headers['x-api-key']), ['test-key-high', 'test-key-low']);
    assert.equal(requests[0].headers['anthropic-workspace-id'], 'workspace-high');
    assert.equal(requests[1].headers['anthropic-workspace-id'], 'workspace-low');
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].headers['anthropic-beta'], 'prompt-caching-2024-07-31');
    assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(requests[0].headers['user-agent'], 'Claude Code integration test');
    assert.deepEqual(requests.map(item => item.body), [originalBody, originalBody]);
    assert.equal(sent[0].status, 200);
    assert.equal(typeof sent[0].body.getReader, 'function');
    assert.match((await collect(sent[0].body)).toString(), /event: message_start/);
    assert.equal(sent[0].headers['content-type'], 'text/event-stream');
  });

  it('rotates past workspace authorization errors but keeps 5xx on the selected account', async () => {
    requests.length = 0;
    const sent = [];
    const base = {
      method: 'POST', path: '/v1/messages/count_tokens', headers: {}, body: Buffer.from('{"model":"claude-opus-4-1"}'),
      secret: account => `key-${account.name}`,
      request: async (method, path, headers, body) => {
        const response = await fetch(new URL(path, origin), { method, headers, body });
        return { status: response.status, headers: Object.fromEntries(response.headers), stream: response.body };
      },
      send: (status, headers, body) => sent.push({ status, body }),
    };
    await routeApiFallback({ ...base, accounts: [
      { name: 'bad-workspace', service: 's', account: 'a', priority: 20, workspaceId: 'workspace-rejected' },
      { name: 'backup', service: 's', account: 'b', priority: 10, workspaceId: 'workspace-backup' },
    ] });
    assert.equal(requests.length, 2);
    assert.equal(sent[0].status, 200);

    let attemptCount = 0;
    await routeApiFallback({ ...base, accounts: [
      { name: 'first', service: 's', account: 'a', priority: 20 },
      { name: 'second', service: 's', account: 'b', priority: 10 },
    ], request: async () => { attemptCount++; return { status: 503, body: Buffer.from('temporarily unavailable') }; } });
    assert.equal(attemptCount, 1);
  });

  it('does not spend an API account while OAuth is selectable', async () => {
    let called = false;
    const handled = await routeApiFallback({
      method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}'), oauthSelectable: true,
      accounts: [{ name: 'api', service: 's', account: 'a', priority: 99 }],
      secret: () => { called = true; return 'never-read'; }, request: async () => { called = true; }, send() {},
    });
    assert.equal(handled, false);
    assert.equal(called, false);
  });

  it('uses the real API fallback seam after OAuth is exhausted for this model mid-request', async () => {
    requests.length = 0;
    const oauthAccounts = [{ name: 'oauth-main', token: 'tok-finto', disabled: false }];
    const blockedForModel = new Set(['oauth-main']);
    const sent = [];

    const oauthServer = createServer((req, res) => {
      res.writeHead(429, { 'retry-after': '3600', 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    });
    await new Promise(resolve => oauthServer.listen(0, '127.0.0.1', resolve));
    const oauthResult = await fetch(`http://127.0.0.1:${oauthServer.address().port}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(oauthResult.status, 429);
    await new Promise(resolve => oauthServer.close(resolve));

    const handled = await routeApiFallback({
      method: 'POST', path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' },
      body: Buffer.from('{"model":"claude-opus-4-1","max_tokens":19}'),
      oauthAccounts,
      isOAuthSelectable: account => isOAuthPotentiallySelectable(account, {
        isAvailable: () => true,
        isModelBlocked: item => blockedForModel.has(item.name),
      }),
      accounts: [{ name: 'api-fallback', service: 'test', account: 'fallback', priority: 1 }],
      secret: () => 'test-key-low',
      request: async (method, path, headers, body) => {
        const response = await fetch(new URL(path, origin), { method, headers, body });
        return { status: response.status, headers: Object.fromEntries(response.headers), stream: response.body };
      },
      send: (status, headers, body) => sent.push({ status, headers, body }),
    });
    assert.equal(handled, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers['x-api-key'], 'test-key-low');
    assert.equal(sent[0].status, 200);
    assert.match((await collect(sent[0].body)).toString(), /event: message_start/);
  });

  it('keeps API fallback idle for an expired OAuth token with a refresh token', async () => {
    let apiAttempts = 0;
    const oauthAccount = {
      name: 'oauth-refreshable', token: 'expired-token', expiresAt: Date.now() - 1000,
      creds: { claudeAiOauth: { accessToken: 'expired-token', refreshToken: 'fixture-refresh-token' } },
    };
    const handled = await routeApiFallback({
      method: 'POST', path: '/v1/messages', headers: {}, body: Buffer.from('{}'),
      oauthAccounts: [oauthAccount],
      isOAuthSelectable: account => isOAuthPotentiallySelectable(account, {
        isAvailable: () => false,
      }),
      accounts: [{ name: 'api', service: 'test', account: 'api', priority: 1 }],
      secret: () => { apiAttempts++; return 'never-read'; },
      request: async () => { apiAttempts++; }, send() {},
    });
    assert.equal(handled, false);
    assert.equal(apiAttempts, 0);
    assert.equal(isOAuthPotentiallySelectable(oauthAccount, { isAvailable: () => false, refreshAttempted: true }), false);
    assert.equal(isOAuthPotentiallySelectable(oauthAccount, { isAvailable: () => false, state: { limited: true, retryAfter: Date.now() + 60_000 } }), false);
  });

  it('serializes profile metadata without credentials or usage claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdm-api-accounts-'));
    const file = join(dir, 'api-accounts.json');
    writeFileSync(file, JSON.stringify([{ name: 'api-main', label: 'API main', service: 'vdm-test', account: 'main', workspaceId: 'workspace-test', priority: 5, disabled: false, key: 'test-key-high' }]));
    const serialized = JSON.stringify(safeApiProfiles(file));
    assert.equal(serialized.includes('test-key-high'), false);
    assert.equal(serialized.includes('service'), false);
    assert.equal(serialized.includes('workspace-test'), true);
    assert.match(serialized, /"usage5h":null/);
    const headers = buildApiHeaders({ authorization: 'bearer', 'x-api-key': 'caller', 'anthropic-beta': 'oauth-2025-04-20' }, {}, 'secret', 2);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-api-key'], 'secret');
    assert.equal(headers['anthropic-beta'], undefined);
    unlinkSync(file);
    rmdirSync(dir);
  });
});

function collect(stream) {
  return new Promise(resolve => {
    const chunks = [];
    (async () => {
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      resolve(Buffer.concat(chunks));
    })();
  });
}
