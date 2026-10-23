// Prompt-cache breakpoints in the OpenAI -> Messages translation.
//
// Why this is not cosmetic: without an explicit cache_control breakpoint
// Anthropic bills the whole prompt on every turn. Measured on the live proxy
// before the fix, the same 9534-token system prompt was billed 9534 twice in a
// row with zero cache reads. A cached read costs roughly a tenth of a fresh one,
// so the 5h window drains about ten times faster — and it surfaces as "vdm eats
// my quota", never as an error. That is the kind of bug that hides for weeks.
//
// After the fix, measured over three turns:
//   turno 1: cacheWrite=0    cacheRead=9226   (prefix already warm)
//   turno 2: cacheWrite=155  cacheRead=9226
//   turno 3: cacheWrite=245  cacheRead=9381   <- growing, i.e. history IS cached
//
// Mirrored from openaiToMessages() in dashboard.mjs, which starts a server on
// import. LOCAL-PATCHES.md records the pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const EPHEMERAL = { type: 'ephemeral' };

/** The cache-breakpoint half of openaiToMessages(), mirrored. */
function applyCacheBreakpoints(systemBlocks, messages) {
  const lastSystem = systemBlocks[systemBlocks.length - 1];
  if (lastSystem && typeof lastSystem.text === 'string' && lastSystem.text.length > 200) {
    lastSystem.cache_control = { type: 'ephemeral' };
  }
  if (messages.length >= 3) {
    const anchor = messages[messages.length - 2];
    if (typeof anchor.content === 'string') {
      anchor.content = [{ type: 'text', text: anchor.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(anchor.content) && anchor.content.length) {
      const lastBlock = anchor.content[anchor.content.length - 1];
      if (lastBlock && typeof lastBlock === 'object') lastBlock.cache_control = { type: 'ephemeral' };
    }
  }
  return { systemBlocks, messages };
}

const longText = 'x'.repeat(500);
const sys = (text) => [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, { type: 'text', text }];
const turns = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant', content: 'turno ' + i,
}));

test('a long system prompt gets a cache breakpoint', () => {
  const { systemBlocks } = applyCacheBreakpoints(sys(longText), turns(1));
  assert.deepEqual(systemBlocks[systemBlocks.length - 1].cache_control, EPHEMERAL);
});

test('the breakpoint goes on the LAST system block, not the identity', () => {
  // Marking the identity alone would cache 57 characters and leave the real
  // payload — the caller's prompt — uncached.
  const { systemBlocks } = applyCacheBreakpoints(sys(longText), turns(1));
  assert.equal(systemBlocks[0].cache_control, undefined);
  assert.deepEqual(systemBlocks[1].cache_control, EPHEMERAL);
});

test('a short system prompt is NOT marked', () => {
  // Anthropic has a minimum cacheable size; below it the write is wasted and
  // billed. Each account also has a small number of breakpoints, so spending
  // one on a two-line prompt is worse than not caching.
  const { systemBlocks } = applyCacheBreakpoints(sys('breve'), turns(1));
  assert.equal(systemBlocks[systemBlocks.length - 1].cache_control, undefined);
});

test('the identity alone is never marked when it is the only block', () => {
  const only = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }];
  const { systemBlocks } = applyCacheBreakpoints(only, turns(1));
  assert.equal(systemBlocks[0].cache_control, undefined, 'too short to be worth a breakpoint');
});

test('the conversation anchor is the LAST-BUT-ONE turn', () => {
  // The final turn changes on every request. A breakpoint there would
  // invalidate the entry each time: a cache WRITE per turn, which costs more
  // than not caching at all. This is the assertion that protects the bill.
  const ms = turns(5);
  applyCacheBreakpoints(sys(longText), ms);
  const anchor = ms[ms.length - 2];
  const last = ms[ms.length - 1];
  assert.ok(Array.isArray(anchor.content) && anchor.content[0].cache_control, 'anchor must be marked');
  assert.equal(typeof last.content, 'string', 'the newest turn must stay untouched');
});

test('a short conversation gets no anchor', () => {
  // With fewer than three turns there is no stable history worth a breakpoint.
  const ms = turns(2);
  applyCacheBreakpoints(sys(longText), ms);
  assert.ok(ms.every(m => typeof m.content === 'string'));
});

test('the anchor keeps the original text intact', () => {
  // The wrapping must not alter what the model reads, or the answer changes.
  const ms = turns(4);
  const original = ms[ms.length - 2].content;
  applyCacheBreakpoints(sys(longText), ms);
  assert.equal(ms[ms.length - 2].content[0].text, original);
});

test('a block-array turn is marked on its last block, without losing blocks', () => {
  const ms = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'text', text: 'uno' }, { type: 'text', text: 'due' }] },
    { role: 'user', content: 'b' },
  ];
  applyCacheBreakpoints(sys(longText), ms);
  assert.equal(ms[1].content.length, 2, 'no block may be dropped');
  assert.equal(ms[1].content[0].cache_control, undefined);
  assert.deepEqual(ms[1].content[1].cache_control, EPHEMERAL);
});

test('a tool_result anchor is marked without breaking its shape', () => {
  // Tool results are the bulk of a coding session's history, so this is the
  // case that matters most in practice.
  const ms = [
    { role: 'user', content: 'run' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'output' }] },
    { role: 'user', content: 'e adesso?' },
  ];
  applyCacheBreakpoints(sys(longText), ms);
  const block = ms[1].content[0];
  assert.equal(block.type, 'tool_result', 'the block type must survive');
  assert.equal(block.tool_use_id, 'c1');
  assert.deepEqual(block.cache_control, EPHEMERAL);
});

test('at most two breakpoints are ever set', () => {
  // Anthropic caps breakpoints per request; exceeding it is a 400 that would
  // take down every long session at once.
  const ms = turns(9);
  const { systemBlocks } = applyCacheBreakpoints(sys(longText), ms);
  const count = systemBlocks.filter(b => b.cache_control).length +
    ms.filter(m => Array.isArray(m.content) && m.content.some(b => b?.cache_control)).length;
  assert.ok(count <= 2, 'found ' + count + ' breakpoints');
});

test('an empty anchor content array does not crash', () => {
  const ms = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [] },
    { role: 'user', content: 'b' },
  ];
  assert.doesNotThrow(() => applyCacheBreakpoints(sys(longText), ms));
});
