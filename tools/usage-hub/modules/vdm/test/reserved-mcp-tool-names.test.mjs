// Anthropic reserves the `mcp_` prefix for its own MCP connector tools and
// rejects any request whose tool list declares one — as a 400
// invalid_request_error reading "You're out of extra usage. Add more at
// claude.ai/settings/usage and keep going."  A billing sentence for a schema
// problem, which is why 2026-08-24 looked all day like four exhausted accounts
// while the same tokens answered 200 on the very next request.
//
// Measured against the live API on 2026-08-24, same token, one tool per call:
//   mcp_call / mcp_search / mcp_x / mcp_a / mcp_call_x  -> 400
//   mcp / mcpfoo / mcpcall / mcp-call / MCP_call        -> 200
//   mcp__gateway__x / mcp_ / mcp_1 / jcode_mcp_call     -> 200
// and jcode's full 33-tool set: untouched -> 400, with the two offenders
// renamed -> 200.
//
// The functions under test are extracted from dashboard.mjs itself rather than
// mirrored, so this file cannot pass while production is broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Normalised to LF on read. These tests slice the source on "\n}\n"; if git
// checked the file out with CRLF (the Windows default) that needle never
// matches, and the failure reads "<function> is not defined" — which points at
// the code rather than at the invisible byte that actually broke it.
const src = readFileSync(join(here, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in dashboard.mjs`);
  // Brace-match to the end of the declaration.
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`unbalanced braces while extracting ${name}`);
}

const prefixRe = src.match(/const RESERVED_TOOL_PREFIX_RE = ([^;]+);/);
const aliasPrefix = src.match(/const TOOL_ALIAS_PREFIX = ('[^']*'|"[^"]*");/);
assert.ok(prefixRe && aliasPrefix, 'reserved-prefix constants not found in dashboard.mjs');

const sandbox = new Function(`
  const RESERVED_TOOL_PREFIX_RE = ${prefixRe[1]};
  const TOOL_ALIAS_PREFIX = ${aliasPrefix[1]};
  ${extract('isReservedToolName')}
  ${extract('aliasToolName')}
  ${extract('unaliasToolName')}
  ${extract('requestHasReservedMcpToolName')}
  ${extract('isOpenClawRequest')}
  ${extract('isReservedMcpSchemaError')}
  ${extract('isOpenClawExtraUsageError')}
  return {
    isReservedToolName, aliasToolName, unaliasToolName, TOOL_ALIAS_PREFIX,
    requestHasReservedMcpToolName, isOpenClawRequest,
    isReservedMcpSchemaError, isOpenClawExtraUsageError,
  };
`)();
const {
  isReservedToolName, aliasToolName, unaliasToolName, TOOL_ALIAS_PREFIX,
  requestHasReservedMcpToolName, isOpenClawRequest,
  isReservedMcpSchemaError, isOpenClawExtraUsageError,
} = sandbox;

// The exact names measured as rejected upstream.
const REJECTED_UPSTREAM = ['mcp_call', 'mcp_search', 'mcp_x', 'mcp_a', 'mcp_call_x'];
// The exact names measured as accepted upstream — renaming these would be
// gratuitous, and for `mcp__server__tool` it would break the real MCP connector.
const ACCEPTED_UPSTREAM = ['mcp', 'mcpfoo', 'mcpcall', 'mcp-call', 'MCP_call',
  'mcp__gateway__x', 'mcp_', 'mcp_1', 'jcode_mcp_call', 'bash', 'read', 'websearch'];

test('every name Anthropic rejected is renamed before it goes upstream', () => {
  for (const name of REJECTED_UPSTREAM) {
    assert.equal(isReservedToolName(name), true, `${name} should be treated as reserved`);
    assert.notEqual(aliasToolName(name), name, `${name} must not go upstream unchanged`);
    assert.equal(isReservedToolName(aliasToolName(name)), false,
      `the alias for ${name} must not itself be rejected`);
  }
});

test('every name Anthropic accepted is passed through untouched', () => {
  for (const name of ACCEPTED_UPSTREAM) {
    assert.equal(aliasToolName(name), name, `${name} must not be renamed`);
  }
});

test('the MCP connector namespace mcp__server__tool survives', () => {
  // Claude Code's own MCP tools arrive in this form on the native route and are
  // accepted upstream; renaming them would break tool routing for no reason.
  assert.equal(aliasToolName('mcp__gateway__skills_attic__list'), 'mcp__gateway__skills_attic__list');
});

test('the caller always sees back the tool name it declared', () => {
  for (const name of [...REJECTED_UPSTREAM, ...ACCEPTED_UPSTREAM]) {
    assert.equal(unaliasToolName(aliasToolName(name)), name, `round trip failed for ${name}`);
  }
});

test('un-aliasing only strips a prefix this proxy added', () => {
  // A tool genuinely named with the alias prefix must not be mangled on the way
  // back: only names the proxy itself rewrote may be rewritten again.
  assert.equal(aliasToolName(`${TOOL_ALIAS_PREFIX}mcp_call`), `${TOOL_ALIAS_PREFIX}mcp_call`);
});

test('outbound translation aliases tool definitions, tool_choice and transcript', () => {
  const toMessages = extract('openaiToMessages');
  // Definitions.
  assert.match(toMessages, /name: aliasToolName\(t\.function\.name\)/);
  // A forced tool choice.
  assert.match(toMessages, /type: 'tool', name: aliasToolName\(tc\.function\.name\)/);
  // Earlier assistant turns: a transcript naming mcp_call is rejected exactly
  // like a declaration of it, so history has to carry the alias too.
  assert.match(toMessages, /type: 'tool_use', id: tc\.id, name: aliasToolName\(/);
});

test('both return paths restore the original name', () => {
  // Non-streaming JSON response.
  assert.match(extract('messagesToOpenai'), /name: unaliasToolName\(b\.name\)/);
  // Streaming SSE response: jcode always streams, so a fix that only covered
  // the JSON path would fix nothing in practice.
  assert.match(extract('createOpenaiSseTranslator'), /name: unaliasToolName\(e\.content_block\.name\)/);
});

test('a native reserved-MCP schema rejection is never mistaken for billing', () => {
  const exactError = "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
  const body = Buffer.from(JSON.stringify({
    tools: [{ name: 'mcp_call', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'mcp_search' },
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp_x', input: {} }],
    }],
  }));

  assert.equal(requestHasReservedMcpToolName(body), true);
  assert.equal(isReservedMcpSchemaError('invalid_request_error', exactError, body), true);
});

test('a real extra-usage response stays eligible for failover', () => {
  const exactError = "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
  const acceptedMcpBody = Buffer.from(JSON.stringify({
    tools: [{ name: 'mcp__openclaw__web_fetch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hello' }],
  }));

  assert.equal(requestHasReservedMcpToolName(acceptedMcpBody), false);
  assert.equal(isReservedMcpSchemaError('invalid_request_error', exactError, acceptedMcpBody), false);
});

test('OpenClaw extra-usage replies are isolated from VDM global account state', () => {
  const exactError = "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
  const body = Buffer.from(JSON.stringify({
    system: [{ type: 'text', text: 'You are Claude Code.\nWorking directory: /Users/dev/.openclaw\n' }],
    tools: [{ name: 'mcp__openclaw__web_fetch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hello' }],
  }));

  assert.equal(isOpenClawRequest(body), true);
  assert.equal(isOpenClawExtraUsageError('invalid_request_error', exactError, body), true);
  assert.equal(isReservedMcpSchemaError('invalid_request_error', exactError, body), false);
});

test('ordinary Claude requests retain normal extra-usage failover', () => {
  const exactError = "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
  const body = Buffer.from(JSON.stringify({
    system: [{ type: 'text', text: 'You are Claude Code.\nWorking directory: /Users/dev/Projects/darkroom\n' }],
    messages: [{ role: 'user', content: 'hello' }],
  }));

  assert.equal(isOpenClawRequest(body), false);
  assert.equal(isOpenClawExtraUsageError('invalid_request_error', exactError, body), false);
});

test('the reserved-MCP guard returns before cooldown or account switching', () => {
  const guardStart = src.indexOf('if (isReservedMcpSchemaError(errorType, errorMessage, body))');
  const billingMarkStart = src.indexOf('if (isBillingError && token)', guardStart);
  assert.ok(guardStart >= 0 && billingMarkStart > guardStart, 'reserved-MCP guard must precede billing recovery');
  const guard = src.slice(guardStart, billingMarkStart);
  assert.match(guard, /clientRes\.writeHead\(400, proxyRes\.headers\)/);
  assert.match(guard, /clientRes\.end\(bodyBuf\)/);
  assert.match(guard, /return;/);
  assert.doesNotMatch(guard, /markAccountLimited|writeKeychain|auto-switch/);
});

test('the OpenClaw guard retries locally and never mutates VDM account state', () => {
  const reservedGuardStart = src.indexOf('if (isReservedMcpSchemaError(errorType, errorMessage, body))');
  const guardStart = src.indexOf('if (isOpenClawExtraUsageError(errorType, errorMessage, body))');
  const billingMarkStart = src.indexOf('if (isBillingError && token)', guardStart);
  assert.ok(reservedGuardStart >= 0 && guardStart > reservedGuardStart && billingMarkStart > guardStart,
    'OpenClaw guard must follow the specific schema guard and precede billing recovery');
  const guard = src.slice(guardStart, billingMarkStart);
  assert.match(guard, /token = next\.token/);
  assert.match(guard, /openclaw-isolated-retry/);
  assert.match(guard, /clientRes\.writeHead\(400, proxyRes\.headers\)/);
  assert.match(guard, /clientRes\.end\(bodyBuf\)/);
  assert.doesNotMatch(guard, /markAccountLimited|writeKeychain|auto-switch|Account Switched/);
});
