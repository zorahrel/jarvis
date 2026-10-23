// An HTTP 200 whose failure is inside the SSE body.
//
// Anthropic answers 200, opens the stream, and about a second later sends an
// `error` event carrying `overloaded_error`. The status line already said
// success, so nothing downstream retries: jcode reads a failed turn on
// `attempt 1/8` and parks the session Idle. Measured 2026-08-18 — nine of them
// in five minutes, every live session frozen for 13 minutes until a human
// pressed enter. The proxy's 529 branch does not catch it: that one matches on
// the HTTP status.
//
// peekStreamHead reads the head of the stream BEFORE writeHead, so a retry is
// still free, and replays every consumed byte into the stream the caller pipes.
// What these tests pin:
//   - the verdict comes from the first event that carries one, ping skipped
//   - only transient upstream errors retry; a real error reaches the client
//   - an overload AFTER the answer started is NOT retried (cannot un-send)
//   - the replay loses no bytes, whether the peek stopped early or at EOF
//   - an event split across chunks is still parsed (sockets split mid-event)
//
// Mirrored from dashboard.mjs, which starts a server on import.
// LOCAL-PATCHES.md records the pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { UPSTREAM_RETRY_BACKOFF_MS } from '../lib.mjs';

const INBAND_RETRY_ERRORS = new Set(['overloaded_error', 'api_error']);
const INBAND_OVERLOAD_BACKOFF_MS = UPSTREAM_RETRY_BACKOFF_MS;
const INBAND_PEEK_TIMEOUT_MS = 20_000;

function peekStreamHead(res, { timeoutMs = INBAND_PEEK_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const chunks = [];
    let buf = '';
    let settled = false;

    const detach = () => {
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onErr);
      res.pause();
    };

    // `ended` means upstream closed while we were still peeking: there is nothing
    // left to pipe, so the replay stream is closed after the buffered bytes.
    const done = (retryable, errorType, ended) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      const stream = new PassThrough();
      for (const c of chunks) stream.write(c);
      if (ended) stream.end(); else res.pipe(stream);
      resolve({ retryable, errorType, stream });
    };

    const onData = chunk => {
      chunks.push(chunk);
      buf += chunk.toString('utf8');
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const ev of events) {
        const dataLine = ev.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        let e;
        try { e = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (e.type === 'ping') continue;
        if (e.type === 'error') {
          const t = e.error?.type || 'unknown';
          done(INBAND_RETRY_ERRORS.has(t), t, false);
          return;
        }
        done(false, null, false);
        return;
      }
    };
    const onEnd = () => done(false, null, true);
    const onErr = () => done(false, null, true);
    // A stream that says nothing at all is not evidence of an error: hand it over
    // rather than hold the client while upstream thinks.
    const timer = setTimeout(() => done(false, null, false), timeoutMs);

    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onErr);
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const ev = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
const OVERLOAD = ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
const API_ERR  = ev({ type: 'error', error: { type: 'api_error', message: 'Internal' } });
const BAD_REQ  = ev({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } });
const PING     = ev({ type: 'ping' });
const START    = ev({ type: 'message_start', message: { id: 'msg_1' } });
const DELTA    = ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ciao' } });

// Feed chunks into a peeked stream and collect everything that comes out.
async function peekOf(chunks, { endAfter = true } = {}) {
  const src = new PassThrough();
  const verdict = peekStreamHead(src, { timeoutMs: 500 });
  for (const c of chunks) src.write(c);
  if (endAfter) src.end();
  const r = await verdict;
  const out = [];
  for await (const c of r.stream) out.push(c);
  return { ...r, replayed: Buffer.concat(out).toString('utf8') };
}

// ── the verdict ──────────────────────────────────────────────────────────────

test('overloaded_error as the first event is retryable', async () => {
  const r = await peekOf([OVERLOAD]);
  assert.equal(r.retryable, true);
  assert.equal(r.errorType, 'overloaded_error');
});

test('api_error is retryable too — transient upstream capacity, not our request', async () => {
  const r = await peekOf([API_ERR]);
  assert.equal(r.retryable, true);
  assert.equal(r.errorType, 'api_error');
});

test('a real error is NOT retried and reaches the client', async () => {
  const r = await peekOf([BAD_REQ]);
  assert.equal(r.retryable, false);
  assert.equal(r.errorType, 'invalid_request_error');
  assert.match(r.replayed, /invalid_request_error/);
});

test('ping carries no verdict — the error behind it is still seen', async () => {
  const r = await peekOf([PING + PING + OVERLOAD]);
  assert.equal(r.retryable, true);
  assert.equal(r.errorType, 'overloaded_error');
});

test('a real answer stops the peek at message_start', async () => {
  const r = await peekOf([START + DELTA]);
  assert.equal(r.retryable, false);
  assert.equal(r.errorType, null);
});

// This is the line between safe and unsafe: once the answer has started, bytes
// are already on their way to the client and a retry would duplicate them.
test('an overload AFTER the answer started is not retryable', async () => {
  const r = await peekOf([START + DELTA + OVERLOAD]);
  assert.equal(r.retryable, false);
  assert.match(r.replayed, /overloaded_error/, 'it must still reach the client');
});

// ── the replay ───────────────────────────────────────────────────────────────

test('the replay loses nothing when the peek stops on the first chunk', async () => {
  const whole = START + DELTA + ev({ type: 'message_stop' });
  const r = await peekOf([whole]);
  assert.equal(r.replayed, whole);
});

test('the replay carries bytes that arrive after the verdict', async () => {
  const src = new PassThrough();
  const p = peekStreamHead(src, { timeoutMs: 500 });
  src.write(START);
  const r = await p;
  src.write(DELTA);
  src.end();
  const out = [];
  for await (const c of r.stream) out.push(c);
  assert.equal(Buffer.concat(out).toString('utf8'), START + DELTA);
});

test('an event split across chunks is still parsed', async () => {
  const half = Math.floor(OVERLOAD.length / 2);
  const r = await peekOf([OVERLOAD.slice(0, half), OVERLOAD.slice(half)]);
  assert.equal(r.retryable, true);
  assert.equal(r.errorType, 'overloaded_error');
});

test('a stream that ends saying nothing is not an error', async () => {
  const r = await peekOf([]);
  assert.equal(r.retryable, false);
  assert.equal(r.replayed, '');
});

// Silence is not evidence of failure: hand the stream over rather than hold the
// client while upstream is still thinking.
test('a silent stream is released by the timeout, not retried', async () => {
  const src = new PassThrough();
  const started = Date.now();
  const r = await peekStreamHead(src, { timeoutMs: 120 });
  assert.equal(r.retryable, false);
  assert.ok(Date.now() - started >= 100, 'it waited for the timeout');
  src.end();
});

// ── the retry budget ─────────────────────────────────────────────────────────

test('the backoff grows and is bounded — a stuck upstream cannot loop forever', () => {
  assert.deepEqual(INBAND_OVERLOAD_BACKOFF_MS, [1000, 2000, 4000]);
  const total = INBAND_OVERLOAD_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.ok(total < 45_000, 'the whole budget must fit inside REQUEST_DEADLINE_MS');
});
