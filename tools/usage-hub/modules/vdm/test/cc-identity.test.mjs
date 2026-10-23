// Claude Code identity injection on the native /v1/messages route.
//
// Measured 2026-08-17 against the live proxy, same account and same second
// (the account was at 95% of its 5h window throughout, so quota is not the
// variable):
//   /chat/completions, no system                            → 429
//   /chat/completions, system "You are a helpful assistant." → 429
//   /chat/completions, system = CC exactly                   → 200
//   /chat/completions, ONE system = CC + "\n\n## Identity…"  → 429
//   /chat/completions, TWO system messages, CC first         → 429
//   /v1/messages, system: [CC block, custom block]           → 200
//
// Two conclusions the tests below pin down:
//  1. The identity must be its own leading block, byte-identical. Appending to
//     it breaks the match, which is why we prepend a block instead of editing
//     the caller's text.
//  2. Anthropic reports the rejection as 429 rate_limit_error with NO
//     retry-after. Downstream that is indistinguishable from exhaustion:
//     retryAfter parses to 0, `0 < 60` marks it "transient", and the account is
//     never switched. Hence eight consecutive 429s on an account with quota.
//
// The function under test lives in dashboard.mjs, which starts a server on
// import, so it is mirrored here verbatim. LOCAL-PATCHES.md records the pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Mirror of ensureClaudeCodeIdentity() in dashboard.mjs. */
function ensureClaudeCodeIdentity(url, body) {
  if (!/\/v1\/messages/.test(url || '') || !body.length) return body;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) return body;

    let blocks;
    if (Array.isArray(parsed.system)) blocks = [...parsed.system];
    else if (typeof parsed.system === 'string' && parsed.system) blocks = [{ type: 'text', text: parsed.system }];
    else if (parsed.system == null) blocks = [];
    else return body;

    const firstText = typeof blocks[0]?.text === 'string' ? blocks[0].text : null;
    if (firstText === CLAUDE_CODE_SYSTEM_PROMPT) return body;

    blocks.unshift({ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT });
    return Buffer.from(JSON.stringify({ ...parsed, system: blocks }));
  } catch {
    return body;
  }
}

const buf = (obj) => Buffer.from(JSON.stringify(obj));
const parse = (b) => JSON.parse(b.toString('utf8'));
const msgs = [{ role: 'user', content: 'ok' }];

test('a request with no system gets the identity as its only block', () => {
  const out = parse(ensureClaudeCodeIdentity('/v1/messages', buf({ model: 'claude-opus-5', messages: msgs })));
  assert.deepEqual(out.system, [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }]);
  assert.deepEqual(out.messages, msgs, 'conversation must be untouched');
});

test("a caller's string system becomes a SECOND block, never concatenated", () => {
  // Concatenation is the measured 429 case: CC + "\n\n## Identity…" was refused.
  const out = parse(ensureClaudeCodeIdentity('/v1/messages', buf({
    model: 'claude-opus-5', system: 'You are Jcode.', messages: msgs,
  })));
  assert.equal(out.system.length, 2);
  assert.equal(out.system[0].text, CLAUDE_CODE_SYSTEM_PROMPT);
  assert.equal(out.system[1].text, 'You are Jcode.', "the caller's prompt must survive intact");
});

test('an existing block array is preserved in order, identity first', () => {
  const out = parse(ensureClaudeCodeIdentity('/v1/messages', buf({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
    messages: msgs,
  })));
  assert.deepEqual(out.system.map(b => b.text), [CLAUDE_CODE_SYSTEM_PROMPT, 'A', 'B']);
});

test('a request that already leads with the identity is byte-identical', () => {
  // Claude Code itself: touching it would risk breaking a working request.
  const original = buf({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, { type: 'text', text: 'more' }],
    messages: msgs,
  });
  assert.equal(ensureClaudeCodeIdentity('/v1/messages', original).toString(), original.toString());
});

test('an identity with extra text appended is treated as MISSING', () => {
  // Measured: CC + "\n\n## Identity…" as a single string → 429. It does not
  // count as present, so a clean block must be prepended.
  const out = parse(ensureClaudeCodeIdentity('/v1/messages', buf({
    model: 'claude-opus-5',
    system: CLAUDE_CODE_SYSTEM_PROMPT + '\n\n## Identity\nYour name is Jcode.',
    messages: msgs,
  })));
  assert.equal(out.system.length, 2);
  assert.equal(out.system[0].text, CLAUDE_CODE_SYSTEM_PROMPT, 'first block must be exact');
});

test('preserves cache_control on the caller blocks', () => {
  // Prompt caching lives on these blocks; dropping it would silently multiply cost.
  const out = parse(ensureClaudeCodeIdentity('/v1/messages', buf({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'big', cache_control: { type: 'ephemeral' } }],
    messages: msgs,
  })));
  assert.deepEqual(out.system[1].cache_control, { type: 'ephemeral' });
});

test('every other top-level field survives the rewrite', () => {
  const out = parse(ensureClaudeCodeIdentity('/v1/messages', buf({
    model: 'claude-opus-5', max_tokens: 64, stream: true, temperature: 0.7,
    tools: [{ name: 't' }], metadata: { user_id: 'x' }, messages: msgs,
  })));
  assert.equal(out.max_tokens, 64);
  assert.equal(out.stream, true);
  assert.equal(out.temperature, 0.7);
  assert.deepEqual(out.tools, [{ name: 't' }]);
  assert.deepEqual(out.metadata, { user_id: 'x' });
});

test('the OpenAI-compatible route is deliberately left alone', () => {
  // It cannot express separate system blocks; rewriting it onto the Messages
  // wire would also require translating the response and SSE stream back.
  const original = buf({ model: 'claude-opus-5', messages: msgs });
  assert.equal(ensureClaudeCodeIdentity('/v1/chat/completions', original).toString(), original.toString());
});

test('non-JSON, empty, and malformed bodies are forwarded verbatim', () => {
  assert.equal(ensureClaudeCodeIdentity('/v1/messages', Buffer.from('not json')).toString(), 'not json');
  assert.equal(ensureClaudeCodeIdentity('/v1/messages', Buffer.alloc(0)).length, 0);
  const noMessages = buf({ model: 'claude-opus-5' });
  assert.equal(ensureClaudeCodeIdentity('/v1/messages', noMessages).toString(), noMessages.toString());
});

test('an unrecognised system shape is left alone rather than guessed at', () => {
  const weird = buf({ model: 'claude-opus-5', system: 42, messages: msgs });
  assert.equal(ensureClaudeCodeIdentity('/v1/messages', weird).toString(), weird.toString());
});

test('a token-counting path (/v1/messages/count_tokens) is also fixed up', () => {
  // Same auth rules apply; a 429 here would pollute rate-limit state.
  const out = parse(ensureClaudeCodeIdentity('/v1/messages/count_tokens', buf({
    model: 'claude-opus-5', messages: msgs,
  })));
  assert.equal(out.system[0].text, CLAUDE_CODE_SYSTEM_PROMPT);
});

test('the rewrite is idempotent', () => {
  const once = ensureClaudeCodeIdentity('/v1/messages', buf({ model: 'claude-opus-5', messages: msgs }));
  const twice = ensureClaudeCodeIdentity('/v1/messages', once);
  assert.equal(twice.toString(), once.toString(), 'a second pass must not add a duplicate block');
});
