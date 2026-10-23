// OpenAI-compatible route → native Messages wire, and back.
//
// Why the translation exists: Anthropic serves an OAuth subscription token only
// when Claude Code's identity is the FIRST system block, STANDING ALONE. On
// /chat/completions a second system message is merged into the first upstream,
// and appending to the identity breaks it too. Both measured as 429 with NO
// retry-after, which downstream is indistinguishable from exhaustion.
//
// Measured 2026-08-17 with the account at 0% of its 5h window (quota constant):
//   /chat/completions carrying jcode's own system prompt      → 429
//   the same content as /v1/messages, system:[CC, jcode]       → 200
// and the caller's instructions were obeyed in the 200 (answer in Italian,
// ending with the requested marker), which is what makes demoting the caller's
// prompt to a second system BLOCK safe rather than a silent behaviour change.
//
// Mirrored from dashboard.mjs, which starts a server on import.
// LOCAL-PATCHES.md records the pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const STOP_REASON_MAP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };

function openaiToMessages(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) return null;
  const systemBlocks = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }];
  const messages = [];
  for (const m of parsed.messages) {
    const content = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map(b => (typeof b === 'string' ? b : b?.text || '')).join('')
        : '';
    if (m?.role === 'system') {
      if (content && content !== CLAUDE_CODE_SYSTEM_PROMPT) systemBlocks.push({ type: 'text', text: content });
    } else if (m?.role === 'assistant' || m?.role === 'user') {
      messages.push({ role: m.role, content: Array.isArray(m.content) ? m.content : content });
    }
  }
  if (!messages.length) return null;
  const out = {
    model: parsed.model,
    max_tokens: parsed.max_tokens ?? parsed.max_completion_tokens ?? 8192,
    system: systemBlocks,
    messages,
  };
  if (parsed.stream) out.stream = true;
  if (typeof parsed.temperature === 'number') out.temperature = parsed.temperature;
  if (typeof parsed.top_p === 'number') out.top_p = parsed.top_p;
  if (parsed.stop) out.stop_sequences = Array.isArray(parsed.stop) ? parsed.stop : [parsed.stop];
  return out;
}

function messagesToOpenai(msg) {
  const text = (msg.content || []).filter(b => b?.type === 'text').map(b => b.text).join('');
  const u = msg.usage || {};
  return {
    id: msg.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: msg.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: STOP_REASON_MAP[msg.stop_reason] || 'stop',
    }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

// ── request translation ──

test('the identity leads the system blocks and stands alone', () => {
  // The whole point: a merged or suffixed identity is the measured 429.
  const out = openaiToMessages({
    model: 'claude-opus-5',
    messages: [{ role: 'system', content: 'You are Jcode.' }, { role: 'user', content: 'ok' }],
  });
  assert.equal(out.system[0].text, CLAUDE_CODE_SYSTEM_PROMPT);
  assert.equal(out.system.length, 2);
  assert.equal(out.system[1].text, 'You are Jcode.', "the caller's prompt survives as its own block");
});

test('system messages leave the conversation array entirely', () => {
  // A leftover system turn in `messages` is rejected by the Messages API.
  const out = openaiToMessages({
    model: 'claude-opus-5',
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'ok' }],
  });
  assert.deepEqual(out.messages.map(m => m.role), ['user']);
});

test('multi-turn conversations keep their order and roles', () => {
  const out = openaiToMessages({
    model: 'claude-opus-5',
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ],
  });
  assert.deepEqual(out.messages, [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
});

test('max_tokens is always present', () => {
  // Optional for OpenAI, REQUIRED by the Messages API: omitting it is a 400.
  assert.equal(openaiToMessages({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).max_tokens, 8192);
  assert.equal(openaiToMessages({ model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] }).max_tokens, 64);
  assert.equal(openaiToMessages({ model: 'm', max_completion_tokens: 32, messages: [{ role: 'user', content: 'x' }] }).max_tokens, 32);
});

test('sampling params and stop sequences carry over', () => {
  const out = openaiToMessages({
    model: 'm', temperature: 0.3, top_p: 0.9, stop: 'END', stream: true,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(out.temperature, 0.3);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stop_sequences, ['END']);
  assert.equal(out.stream, true);
});

test('stream_options and other OpenAI-only fields are not forwarded', () => {
  // The Messages API rejects unknown top-level fields.
  const out = openaiToMessages({
    model: 'm', stream: true, stream_options: { include_usage: true }, n: 1,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(out.stream_options, undefined);
  assert.equal(out.n, undefined);
});

test('a duplicate identity is not added twice', () => {
  const out = openaiToMessages({
    model: 'm',
    messages: [{ role: 'system', content: CLAUDE_CODE_SYSTEM_PROMPT }, { role: 'user', content: 'x' }],
  });
  assert.equal(out.system.length, 1);
});

test('bodies that cannot be translated return null and are forwarded untouched', () => {
  assert.equal(openaiToMessages(null), null);
  assert.equal(openaiToMessages({ model: 'm' }), null, 'no messages array');
  assert.equal(openaiToMessages({ model: 'm', messages: [] }), null);
  assert.equal(openaiToMessages({ model: 'm', messages: [{ role: 'system', content: 'only system' }] }), null,
    'a system-only body has no turn to send');
});

test('array content is flattened for system, preserved for turns', () => {
  const out = openaiToMessages({
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'S' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  });
  assert.equal(out.system[1].text, 'S');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'hi' }], 'blocks stay blocks');
});

// ── response translation ──

test('a Messages reply becomes a well-formed chat completion', () => {
  const out = messagesToOpenai({
    id: 'msg_1', model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ciao' }],
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.content, 'ciao');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
});

test('thinking blocks are dropped, text is kept', () => {
  // Opus emits a leading empty `thinking` block. Mapping it to content is what
  // produces the "200 with empty content" symptom.
  const out = messagesToOpenai({
    id: 'm', model: 'x', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'vero testo' }],
  });
  assert.equal(out.choices[0].message.content, 'vero testo');
});

test('multiple text blocks are concatenated', () => {
  const out = messagesToOpenai({
    id: 'm', model: 'x', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
  });
  assert.equal(out.choices[0].message.content, 'ab');
});

test('stop reasons map to OpenAI finish reasons', () => {
  const f = (r) => messagesToOpenai({ id: 'm', model: 'x', stop_reason: r, content: [] }).choices[0].finish_reason;
  assert.equal(f('end_turn'), 'stop');
  assert.equal(f('max_tokens'), 'length');
  assert.equal(f('stop_sequence'), 'stop');
  assert.equal(f('tool_use'), 'tool_calls');
  assert.equal(f(undefined), 'stop', 'unknown reasons must not become null');
});

test('a reply with no usage still reports numbers, not undefined', () => {
  const out = messagesToOpenai({ id: 'm', model: 'x', content: [{ type: 'text', text: 'a' }] });
  assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('a round trip preserves the user-visible text', () => {
  const req = openaiToMessages({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'domanda' }] });
  assert.equal(req.messages[0].content, 'domanda');
  const res = messagesToOpenai({ id: 'm', model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'risposta' }] });
  assert.equal(res.choices[0].message.content, 'risposta');
  assert.equal(res.model, 'claude-opus-5');
});
