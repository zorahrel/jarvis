// Tool calling across the OpenAI ↔ Messages translation.
//
// Why this file exists: with tools dropped, the model has no way to act, so it
// *narrates* the call instead. Measured 2026-08-17 before the fix — asked to run
// `echo PROVA-TOOL > /tmp/tool-proof.txt`, it printed the invocation, reported
// "PROVA-TOOL" as the output, and the file did not exist. A confident wrong
// answer is worse than an error, so every leg of the round trip is pinned here.
//
// After the fix the same prompt produced a real `[bash] $` execution and the
// file on disk.
//
// Mirrored from dashboard.mjs, which starts a server on import.
// LOCAL-PATCHES.md records the pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transform } from 'node:stream';

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
    } else if (m?.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content };
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') {
        prev.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
    } else if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      if (content) blocks.push({ type: 'text', text: content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      messages.push({ role: 'assistant', content: blocks });
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
  if (Array.isArray(parsed.tools) && parsed.tools.length) {
    out.tools = parsed.tools.filter(t => t?.function?.name).map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
  }
  if (parsed.tool_choice) {
    const tc = parsed.tool_choice;
    if (tc === 'auto') out.tool_choice = { type: 'auto' };
    else if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc === 'none') delete out.tools;
    else if (tc?.function?.name) out.tool_choice = { type: 'tool', name: tc.function.name };
  }
  return out;
}

function messagesToOpenai(msg) {
  const blocks = msg.content || [];
  const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('');
  const toolCalls = blocks.filter(b => b?.type === 'tool_use').map((b, i) => ({
    index: i, id: b.id, type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }));
  const u = msg.usage || {};
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: msg.id, object: 'chat.completion', created: 1, model: msg.model,
    choices: [{ index: 0, message, finish_reason: STOP_REASON_MAP[msg.stop_reason] || 'stop' }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

// ── tool definitions reach the model ──

test('OpenAI function definitions become Anthropic tools', () => {
  // The whole bug in one assertion: no tools = narrated calls that never run.
  const out = openaiToMessages({
    model: 'm',
    messages: [{ role: 'user', content: 'run it' }],
    tools: [{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    }],
  });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].name, 'bash');
  assert.equal(out.tools[0].description, 'Run a shell command');
  assert.deepEqual(out.tools[0].input_schema.required, ['command'],
    'the schema must survive, or the model calls the tool with wrong arguments');
});

test('a tool with no parameters still gets a valid schema', () => {
  // Anthropic rejects a missing input_schema outright.
  const out = openaiToMessages({
    model: 'm', messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'now' } }],
  });
  assert.deepEqual(out.tools[0].input_schema, { type: 'object', properties: {} });
});

test('tool_choice maps across the two dialects', () => {
  const withChoice = (tool_choice) => openaiToMessages({
    model: 'm', messages: [{ role: 'user', content: 'x' }], tool_choice,
    tools: [{ type: 'function', function: { name: 'bash' } }],
  });
  assert.deepEqual(withChoice('auto').tool_choice, { type: 'auto' });
  assert.deepEqual(withChoice('required').tool_choice, { type: 'any' });
  assert.deepEqual(withChoice({ type: 'function', function: { name: 'bash' } }).tool_choice, { type: 'tool', name: 'bash' });
  assert.equal(withChoice('none').tools, undefined, "'none' must actually remove the tools");
});

test('malformed tool entries are skipped, not forwarded', () => {
  const out = openaiToMessages({
    model: 'm', messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function' }, { type: 'function', function: { name: 'ok' } }],
  });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].name, 'ok');
});

// ── the round trip that makes multi-step tool use work ──

test('an assistant tool call becomes a tool_use block', () => {
  const out = openaiToMessages({
    model: 'm',
    messages: [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
    ],
  });
  const block = out.messages[1].content[0];
  assert.equal(block.type, 'tool_use');
  assert.equal(block.id, 'call_1');
  assert.deepEqual(block.input, { command: 'ls' }, 'arguments must be parsed, not left as a string');
});

test('a tool result becomes a user turn carrying tool_result', () => {
  // Anthropic has no `tool` role: sending one is a 400 and the loop dies on
  // the second step, right after the first tool actually ran.
  const out = openaiToMessages({
    model: 'm',
    messages: [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'PROVA-TOOL' },
    ],
  });
  assert.equal(out.messages[2].role, 'user');
  assert.deepEqual(out.messages[2].content, [{ type: 'tool_result', tool_use_id: 'c1', content: 'PROVA-TOOL' }]);
  assert.ok(!out.messages.some(m => m.role === 'tool'), 'no `tool` role may survive');
});

test('parallel tool results merge into ONE user turn', () => {
  // Two consecutive user turns is a 400; this is the parallel-call case.
  const out = openaiToMessages({
    model: 'm',
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'uno' },
      { role: 'tool', tool_call_id: 'c2', content: 'due' },
    ],
  });
  const toolTurns = out.messages.filter(m => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.equal(toolTurns.length, 1, 'results must be merged');
  assert.equal(toolTurns[0].content.length, 2);
  assert.deepEqual(toolTurns[0].content.map(b => b.tool_use_id), ['c1', 'c2']);
});

test('unparseable arguments degrade to an empty object, not a crash', () => {
  const out = openaiToMessages({
    model: 'm',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'b', arguments: '{broken' } }] },
    ],
  });
  assert.deepEqual(out.messages[1].content[0].input, {});
});

test('text alongside a tool call is preserved before it', () => {
  const out = openaiToMessages({
    model: 'm',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'Ora eseguo:', tool_calls: [{ id: 'c', type: 'function', function: { name: 'b', arguments: '{}' } }] },
    ],
  });
  assert.deepEqual(out.messages[1].content.map(b => b.type), ['text', 'tool_use']);
});

// ── response side ──

test('a tool_use reply becomes OpenAI tool_calls with finish_reason', () => {
  const out = messagesToOpenai({
    id: 'm', model: 'claude-opus-5', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
  });
  const tc = out.choices[0].message.tool_calls[0];
  assert.equal(tc.id, 'tu_1');
  assert.equal(tc.function.name, 'bash');
  assert.equal(tc.function.arguments, '{"command":"ls"}', 'arguments must be a JSON STRING for OpenAI');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.content, null, 'content is null, not "", when there is only a call');
});

test('a plain answer carries no tool_calls key at all', () => {
  const out = messagesToOpenai({ id: 'm', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ciao' }] });
  assert.equal('tool_calls' in out.choices[0].message, false);
  assert.equal(out.choices[0].message.content, 'ciao');
});

test('parallel tool calls keep distinct indices', () => {
  const out = messagesToOpenai({
    id: 'm', model: 'x', stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: 'a', name: 'bash', input: {} },
      { type: 'tool_use', id: 'b', name: 'read', input: {} },
    ],
  });
  assert.deepEqual(out.choices[0].message.tool_calls.map(t => t.index), [0, 1]);
});

// ── streaming tool calls ──

function createOpenaiSseTranslator(model) {
  const id = 'chatcmpl-test';
  const frame = (delta, finish = null) => 'data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n';
  let buf = '';
  let sentRole = false;
  const toolIndexByBlock = new Map();
  let nextToolIndex = 0;
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
          const bt = e.content_block?.type;
          if (bt === 'text' && !sentRole) { sentRole = true; this.push(frame({ role: 'assistant' })); }
          if (bt === 'tool_use') {
            const idx = nextToolIndex++;
            toolIndexByBlock.set(e.index, idx);
            if (!sentRole) { sentRole = true; this.push(frame({ role: 'assistant' })); }
            this.push(frame({ tool_calls: [{ index: idx, id: e.content_block.id, type: 'function', function: { name: e.content_block.name, arguments: '' } }] }));
          }
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          if (!sentRole) { sentRole = true; this.push(frame({ role: 'assistant' })); }
          this.push(frame({ content: e.delta.text }));
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
          const idx = toolIndexByBlock.get(e.index);
          if (idx !== undefined) this.push(frame({ tool_calls: [{ index: idx, function: { arguments: e.delta.partial_json || '' } }] }));
        } else if (e.type === 'message_delta' && e.delta?.stop_reason) {
          this.push(frame({}, STOP_REASON_MAP[e.delta.stop_reason] || 'stop'));
        } else if (e.type === 'message_stop') {
          this.push('data: [DONE]\n\n');
        }
      }
      cb();
    },
    flush(cb) { cb(); },
  });
}

const sse = (o) => 'event: ' + o.type + '\ndata: ' + JSON.stringify(o) + '\n\n';

async function translate(chunks) {
  const t = createOpenaiSseTranslator('claude-opus-5');
  const out = [];
  t.on('data', d => out.push(d.toString('utf8')));
  for (const c of chunks) t.write(c);
  t.end();
  await new Promise(r => t.on('end', r));
  return out.join('');
}

/** Reassemble streamed tool calls the way a client would. */
function assembleToolCalls(stream) {
  const acc = new Map();
  for (const line of stream.split('\n\n')) {
    const p = line.replace(/^data: /, '').trim();
    if (!p || p === '[DONE]') continue;
    let f; try { f = JSON.parse(p); } catch { continue; }
    for (const tc of f.choices?.[0]?.delta?.tool_calls || []) {
      const cur = acc.get(tc.index) || { id: null, name: null, args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      acc.set(tc.index, cur);
    }
  }
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
}

test('streamed tool arguments reassemble into valid JSON', async () => {
  // Arguments arrive as fragments; dropping or reordering them yields a call
  // the client cannot parse, which surfaces as a silently skipped action.
  const out = await translate([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"comm' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    sse({ type: 'message_stop' }),
  ]);
  const calls = assembleToolCalls(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'tu_1');
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(JSON.parse(calls[0].args), { command: 'ls' });
  assert.ok(out.includes('"finish_reason":"tool_calls"'));
});

test('streamed text and a tool call coexist', async () => {
  const out = await translate([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Eseguo' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_2', name: 'bash', input: {} } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
    sse({ type: 'message_stop' }),
  ]);
  assert.ok(out.includes('"content":"Eseguo"'));
  assert.equal(assembleToolCalls(out)[0].name, 'bash');
});

test('two streamed tool calls stay separate', async () => {
  // Anthropic block indices are not OpenAI tool_calls indices; conflating them
  // merges two calls into one and the second action never happens.
  const out = await translate([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'bash', input: {} } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } }),
    sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'b', name: 'read', input: {} } }),
    sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } }),
    sse({ type: 'message_stop' }),
  ]);
  const calls = assembleToolCalls(out);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.id), ['a', 'b']);
  assert.deepEqual(JSON.parse(calls[0].args), { x: 1 });
  assert.deepEqual(JSON.parse(calls[1].args), { y: 2 });
});
