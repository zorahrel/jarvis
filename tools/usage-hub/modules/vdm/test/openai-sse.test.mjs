// SSE stream translation: Anthropic events → OpenAI chunks.
//
// jcode sends `stream: true`, so this is the path that carries every token of
// every answer through the vdm proxy. A silent bug here does not look like an
// error: it looks like the model replying with nothing.
//
// Mirrored from createOpenaiSseTranslator() in dashboard.mjs, which starts a
// server on import. LOCAL-PATCHES.md records the pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transform } from 'node:stream';

const STOP_REASON_MAP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };

function createOpenaiSseTranslator(model) {
  const id = 'chatcmpl-test';
  const created = 1;
  const frame = (delta, finish = null) => 'data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n';
  let buf = '';
  let sentRole = false;
  let inText = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const ev of events) {
        const dataLine = ev.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        let e;
        try { e = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (e.type === 'content_block_start') {
          inText = e.content_block?.type === 'text';
          if (inText && !sentRole) { sentRole = true; this.push(frame({ role: 'assistant' })); }
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          if (!sentRole) { sentRole = true; this.push(frame({ role: 'assistant' })); }
          this.push(frame({ content: e.delta.text }));
        } else if (e.type === 'content_block_stop') {
          inText = false;
        } else if (e.type === 'message_delta' && e.delta?.stop_reason) {
          this.push(frame({}, STOP_REASON_MAP[e.delta.stop_reason] || 'stop'));
        } else if (e.type === 'message_stop') {
          this.push('data: [DONE]\n\n');
        } else if (e.type === 'error') {
          this.push('data: ' + JSON.stringify({ error: e.error }) + '\n\n');
        }
      }
      cb();
    },
    flush(cb) { cb(); },
  });
}

const sse = (o) => 'event: ' + o.type + '\ndata: ' + JSON.stringify(o) + '\n\n';

/** Feed chunks through the translator and collect everything it emits. */
async function translate(chunks, model = 'claude-opus-5') {
  const t = createOpenaiSseTranslator(model);
  const out = [];
  t.on('data', d => out.push(d.toString('utf8')));
  for (const c of chunks) t.write(c);
  t.end();
  await new Promise(r => t.on('end', r));
  return out.join('');
}

/** Reassemble the text a client would actually render. */
function renderedText(s) {
  return s.split('\n\n')
    .map(l => l.replace(/^data: /, '').trim())
    .filter(l => l && l !== '[DONE]')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .map(f => (f.choices && f.choices[0] && f.choices[0].delta && f.choices[0].delta.content) || '')
    .join('');
}

const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

test('the text of a normal answer arrives intact', async () => {
  const out = await translate([
    sse({ type: 'message_start', message: { id: 'm' } }),
    sse(textStart),
    sse(delta('Ciao ')),
    sse(delta('mondo')),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    sse({ type: 'message_stop' }),
  ]);
  assert.equal(renderedText(out), 'Ciao mondo');
  assert.ok(out.includes('"role":"assistant"'), 'the first frame must announce the role');
  assert.ok(out.trimEnd().endsWith('data: [DONE]'), 'the stream must terminate with [DONE]');
});

test('thinking deltas produce no content frames', async () => {
  // This is the regression that surfaces as "200 with an empty answer": a
  // thinking_delta carries no `text`, so mapping it to content emits empty
  // strings and the user sees nothing.
  const out = await translate([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ragiono' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'risposta' } }),
    sse({ type: 'message_stop' }),
  ]);
  assert.equal(renderedText(out), 'risposta');
  assert.ok(!out.includes('ragiono'), 'reasoning must not leak into the answer');
});

test('an event split across TCP chunks is not lost', async () => {
  // Sockets do not respect message boundaries; without buffering the partial
  // tail, every long answer would lose tokens at random.
  const ev = sse(delta('spezzato'));
  const cut = Math.floor(ev.length / 2);
  const out = await translate([
    sse(textStart),
    ev.slice(0, cut), ev.slice(cut),
    sse({ type: 'message_stop' }),
  ]);
  assert.equal(renderedText(out), 'spezzato');
});

test('several events arriving in one chunk are all emitted', async () => {
  const out = await translate([
    sse(textStart) + sse(delta('a')) + sse(delta('b')) + sse({ type: 'message_stop' }),
  ]);
  assert.equal(renderedText(out), 'ab');
});

test('stop_reason reaches the client as finish_reason', async () => {
  const out = await translate([
    sse(textStart),
    sse(delta('x')),
    sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    sse({ type: 'message_stop' }),
  ]);
  assert.ok(out.includes('"finish_reason":"length"'));
});

test('an upstream error is surfaced, not swallowed', async () => {
  // Ending the stream silently would be indistinguishable from an empty answer.
  const out = await translate([
    sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
  ]);
  assert.ok(out.includes('overloaded_error'));
});

test('ping and unknown future events are ignored without breaking the stream', async () => {
  const out = await translate([
    sse({ type: 'ping' }),
    sse(textStart),
    sse(delta('ok')),
    sse({ type: 'some_future_event', data: 1 }),
    sse({ type: 'message_stop' }),
  ]);
  assert.equal(renderedText(out), 'ok');
});

test('a malformed data line does not kill the stream', async () => {
  const out = await translate([
    'data: {not json\n\n',
    sse(textStart),
    sse(delta('sopravvive')),
    sse({ type: 'message_stop' }),
  ]);
  assert.equal(renderedText(out), 'sopravvive');
});

test('unicode split across chunk boundaries is not corrupted', async () => {
  // Accented characters are multi-byte; a naive slice would emit a replacement
  // character in the middle of an Italian answer.
  const out = await translate([
    sse(textStart),
    sse(delta('perché ')),
    sse(delta('è così')),
    sse({ type: 'message_stop' }),
  ]);
  assert.equal(renderedText(out), 'perché è così');
});
