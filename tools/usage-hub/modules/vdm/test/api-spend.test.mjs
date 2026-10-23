import '../../../test-support/isolate-tmp.mjs';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'vdm-api-spend-'));
const spendFile = join(directory, 'api-spend.json');
process.env.VDM_API_SPEND_FILE = spendFile;

const { API_PRICES, priceForModel } = await import('../api-prices.mjs');
const { API_SPEND_FILE, formatApiSpendLine, recordApiSpend, spendSummary } = await import('../api-spend.mjs');
const { routeApiFallback } = await import('../api-accounts.mjs');

after(() => {
  delete process.env.VDM_API_SPEND_FILE;
  rmSync(directory, { recursive: true, force: true });
});

describe('Anthropic API spend', () => {
  it('has list prices for requested models and resolves dated model IDs', () => {
    assert.deepEqual(API_PRICES['claude-opus-4-1'], { input: 15, output: 75, cacheWrite5m: 18.75, cacheRead: 1.5 });
    assert.deepEqual(API_PRICES['claude-opus-5-5'], { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 });
    assert.deepEqual(API_PRICES['claude-sonnet-4-6'], { input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 });
    assert.ok(priceForModel('claude-opus-4-5-20251101'));
    assert.equal(priceForModel('claude-unknown-9'), null);
  });

  it('aggregates Europe/Rome day buckets into today, last 7 days, and since Oct 16', () => {
    recordApiSpend({ keyName: 'account-a', model: 'claude-sonnet-4-5', usage: { input: 1_000_000 }, now: Date.parse('2026-10-10T12:00:00+02:00') });
    recordApiSpend({ keyName: 'operatore', model: 'claude-sonnet-4-6', usage: { output: 100_000 }, now: Date.parse('2026-10-11T12:00:00+02:00') });
    recordApiSpend({ keyName: 'operatore', model: 'claude-unknown-9', usage: { input: 999 }, now: Date.parse('2026-10-09T12:00:00+02:00') });
    recordApiSpend({ keyName: 'account-a', model: 'claude-opus-5-5', usage: { cacheRead: 1_000_000 }, now: Date.parse('2026-10-16T12:00:00+02:00') });
    recordApiSpend({ keyName: 'operatore', model: 'claude-sonnet-4-6', usage: { input: 100_000 }, now: Date.parse('2026-10-16T12:00:00+02:00') });

    const summary = spendSummary({ now: Date.parse('2026-10-16T12:30:00+02:00') });
    assert.equal(summary.currency, 'USD');
    assert.equal(summary.today, 0.5);
    assert.equal(summary.last7d, 5);
    assert.equal(summary.sinceOct16, 0.5);
    assert.equal(summary.perKey['account-a'].last7d, 3.2);
    assert.equal(summary.perKey.operatore.last7d, 1.8);
    assert.equal(summary.line, 'API Claude: $0.50 oggi · $5.00 7g (account-a $3.20, operatore $1.80)');

    const raw = JSON.parse(readFileSync(spendFile, 'utf8'));
    const unknown = raw.days['2026-10-09'].operatore['claude-unknown-9'];
    assert.equal(unknown.input, 999);
    assert.equal(unknown.cost, 0);
    assert.equal(unknown.estimated, false);
  });

  it('prunes buckets older than 90 days on write and warns above $20 in 7 days', () => {
    const raw = JSON.parse(readFileSync(spendFile, 'utf8'));
    raw.days['2026-07-17'] = { operatore: { 'claude-sonnet-4-5': { input: 1, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, estimated: true } } };
    writeFileSync(spendFile, JSON.stringify(raw));
    recordApiSpend({ keyName: 'account-a', model: 'claude-sonnet-4-5', usage: { input: 7_000_000 }, now: Date.parse('2026-10-16T12:00:00+02:00') });
    const pruned = JSON.parse(readFileSync(spendFile, 'utf8'));
    assert.equal(pruned.days['2026-07-17'], undefined);
    assert.match(spendSummary({ now: Date.parse('2026-10-16T12:00:00+02:00') }).line, / ⚠️$/);
    assert.equal(API_SPEND_FILE, spendFile);
  });

  it('records usage from a successful buffered response after fallback eligibility passes', async () => {
    const sent = [];
    const handled = await routeApiFallback({
      method: 'POST', path: '/v1/messages', headers: {},
      body: Buffer.from('{"model":"claude-sonnet-4-5"}'),
      accounts: [{ name: 'operatore', service: 'stub', account: 'stub', priority: 1 }],
      secret: () => 'stub-secret',
      request: async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ usage: {
        input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 8, cache_read_input_tokens: 5,
      } })) }),
      send: (status, headers, body) => sent.push({ status, body }),
    });
    assert.equal(handled, true);
    assert.equal(sent[0].status, 200);
    const summary = spendSummary({ now: Date.now() });
    assert.ok(summary.perKey.operatore.today > 0);
    assert.ok(summary.perKey.operatore.last7d >= summary.perKey.operatore.today);
  });

  it('tees streaming SSE usage without changing the client bytes and takes max counters', async () => {
    const encoder = new TextEncoder();
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_creation_input_tokens":4,"cache_read_input_tokens":9}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":10}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n',
    ];
    const sent = [];
    const before = spendSummary({ now: Date.now() }).perKey['account-a']?.today || 0;
    const handled = await routeApiFallback({
      method: 'POST', path: '/v1/messages?stream=1', headers: {},
      body: Buffer.from('{"model":"claude-opus-4-1-20250805"}'),
      accounts: [{ name: 'account-a', service: 'stub', account: 'stub', priority: 1 }],
      secret: () => 'stub-secret',
      request: async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: new ReadableStream({
        start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); },
      }) }),
      send: (status, headers, stream) => sent.push({ status, headers, stream }),
    });
    assert.equal(handled, true);
    assert.equal(sent[0].status, 200);
    let clientText = '';
    for await (const chunk of sent[0].stream) clientText += new TextDecoder().decode(chunk);
    assert.equal(clientText, frames.join(''));

    for (let tries = 0; tries < 40 && (spendSummary({ now: Date.now() }).perKey['account-a']?.today || 0) === before; tries++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const raw = JSON.parse(readFileSync(spendFile, 'utf8'));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const row = raw.days[day]['account-a']['claude-opus-4-1-20250805'];
    assert.equal(row.input, 120);
    assert.equal(row.output, 15);
    assert.equal(row.cacheWrite, 4);
    assert.equal(row.cacheRead, 9);
    assert.equal(row.estimated, true);
  });

  it('skips count_tokens usage', async () => {
    const before = spendSummary({ now: Date.now() }).last7d;
    await routeApiFallback({
      method: 'POST', path: '/v1/messages/count_tokens', headers: {},
      body: Buffer.from('{"model":"claude-opus-4-1"}'),
      accounts: [{ name: 'operatore', service: 'stub', account: 'stub', priority: 1 }],
      secret: () => 'stub-secret',
      request: async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ usage: { input_tokens: 100_000 } })) }),
      send() {},
    });
    assert.equal(spendSummary({ now: Date.now() }).last7d, before);
  });
});

describe('API spend per key', () => {
  it('per-key rows add up to the total and per-model rows add up to each key', () => {
    const summary = spendSummary({ now: Date.parse('2026-10-16T12:30:00+02:00') });
    for (const field of ['today', 'last7d', 'sinceOct16']) {
      const sum = Object.values(summary.perKey).reduce((s, r) => s + r[field], 0);
      assert.ok(Math.abs(sum - summary[field]) < 1e-9, `${field}: ${sum} vs ${summary[field]}`);
    }
    for (const [key, row] of Object.entries(summary.perKey)) {
      const sum = summary.perKeyModel.filter(m => m.key === key).reduce((s, m) => s + m.last7d, 0);
      assert.ok(Math.abs(sum - row.last7d) < 1e-3, `${key}: ${sum} vs ${row.last7d}`);
    }
    assert.ok(summary.perKeyModel.length >= 2);
  });
});
