// Tests for vdm-helper.mjs — the Node helper that replaced the inline
// `python3 -c` blocks in the shell scripts.
//
// Two things are worth testing here beyond "does it parse JSON": the hook
// installer edits a file the user owns and may have hand-written, and the
// config writer decides JSON types on the shell's behalf. Both were sources of
// real bugs: `vdm config proxy off` used to write the STRING "False", which is
// truthy in JavaScript, so the setting read back as on.

import '../../../test-support/isolate-tmp.mjs';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/Users/...",
// with a leading slash that no filesystem call accepts.
const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'vdm-helper.mjs');

function helper(args, { stdin = '' } = {}) {
  const res = spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    input: stdin,
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

describe('vdm-helper: config.json', () => {
  let dir, cfg;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vdm-helper-'));
    cfg = join(dir, 'config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes booleans as JSON booleans, not strings', () => {
    helper(['config-set', cfg, 'proxyEnabled', 'false', 'bool']);
    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.equal(parsed.proxyEnabled, false);
    assert.notEqual(parsed.proxyEnabled, 'false');
    // The bug this pins: a quoted "False" reads back as truthy.
    assert.equal(typeof parsed.proxyEnabled, 'boolean');
  });

  it('writes numbers as numbers', () => {
    helper(['config-set', cfg, 'rotationIntervalMin', '90', 'number']);
    assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).rotationIntervalMin, 90);
  });

  it('preserves the other keys when writing one', () => {
    writeFileSync(cfg, JSON.stringify({ usageCap5h: 80, rotationStrategy: 'spread' }, null, 2));
    helper(['config-set', cfg, 'proxyEnabled', 'true', 'bool']);
    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.equal(parsed.usageCap5h, 80);
    assert.equal(parsed.rotationStrategy, 'spread');
    assert.equal(parsed.proxyEnabled, true);
  });

  it('reads a missing config as empty rather than failing', () => {
    const { code, out } = helper(['config-get', join(dir, 'nope.json'), 'proxyEnabled']);
    assert.equal(code, 0);
    assert.equal(out, '');
  });

  it('handles a key whose value contains quotes and spaces', () => {
    // The old python3 -c form interpolated this straight into program text.
    const nasty = `it's "quoted" & spaced`;
    helper(['config-set', cfg, 'rotationStrategy', nasty, 'string']);
    assert.equal(helper(['config-get', cfg, 'rotationStrategy']).out, nasty);
  });
});

describe('vdm-helper: Claude Code hooks', () => {
  let dir, settings;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vdm-hooks-'));
    settings = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds both hooks to an empty settings file', () => {
    writeFileSync(settings, '{}');
    helper(['hooks-install', settings, '3333']);
    const s = JSON.parse(readFileSync(settings, 'utf8'));
    assert.ok(JSON.stringify(s.hooks.UserPromptSubmit).includes('/api/session-start'));
    assert.ok(JSON.stringify(s.hooks.Stop).includes('/api/session-stop'));
  });

  it('never touches the user\'s own settings or their own hooks', () => {
    writeFileSync(settings, JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash'] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }, null, 2));

    helper(['hooks-install', settings, '3333']);
    const s = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.permissions.allow, ['Bash']);
    assert.ok(JSON.stringify(s.hooks.UserPromptSubmit).includes('echo mine'),
      'the user\'s own hook must survive');
    assert.ok(JSON.stringify(s.hooks.UserPromptSubmit).includes('/api/session-start'));
  });

  it('is idempotent: installing twice leaves one hook', () => {
    writeFileSync(settings, '{}');
    helper(['hooks-install', settings, '3333']);
    helper(['hooks-install', settings, '3333']);
    const raw = readFileSync(settings, 'utf8');
    const occurrences = raw.split('/api/session-start').length - 1;
    assert.equal(occurrences, 1);
  });

  it('uninstall removes ours and leaves theirs', () => {
    writeFileSync(settings, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }));
    helper(['hooks-install', settings, '3333']);
    helper(['hooks-uninstall', settings, '3333']);
    const s = JSON.parse(readFileSync(settings, 'utf8'));
    const raw = JSON.stringify(s);
    assert.ok(!raw.includes('/api/session-start'), 'our hook must be gone');
    assert.ok(raw.includes('echo mine'), 'their hook must remain');
  });

  it('backs up a corrupt settings file instead of silently discarding it', () => {
    writeFileSync(settings, '{ this is not json');
    helper(['hooks-install', settings, '3333']);
    assert.ok(existsSync(`${settings}.vdm-backup`), 'the unreadable original must be kept');
    assert.equal(readFileSync(`${settings}.vdm-backup`, 'utf8'), '{ this is not json');
    // And the new file must be valid and carry the hooks.
    const s = JSON.parse(readFileSync(settings, 'utf8'));
    assert.ok(JSON.stringify(s.hooks).includes('/api/session-start'));
  });
});

describe('vdm-helper: commit trailer', () => {
  let dir, msg;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vdm-trailer-'));
    msg = join(dir, 'COMMIT_EDITMSG');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const usage = JSON.stringify([
    { model: 'claude-sonnet-4-6-20250514', inputTokens: 1000, outputTokens: 234 },
    { model: 'claude-sonnet-4-6-20250514', inputTokens: 500, outputTokens: 100 },
  ]);

  it('appends a Token-Usage trailer with a shortened model name', () => {
    writeFileSync(msg, 'Fix the thing\n');
    helper(['commit-trailer', msg], { stdin: usage });
    const out = readFileSync(msg, 'utf8');
    assert.ok(out.startsWith('Fix the thing'));
    assert.ok(out.includes('Token-Usage: sonnet 4.6: 1,500 / 334'), out);
  });

  it('never duplicates an existing trailer', () => {
    writeFileSync(msg, 'Fix\n\nToken-Usage: sonnet 4.6: 1 / 1\n');
    helper(['commit-trailer', msg], { stdin: usage });
    const out = readFileSync(msg, 'utf8');
    assert.equal(out.split('Token-Usage:').length - 1, 1);
  });

  it('leaves the message alone when there is no usage', () => {
    writeFileSync(msg, 'Fix\n');
    helper(['commit-trailer', msg], { stdin: '[]' });
    assert.equal(readFileSync(msg, 'utf8'), 'Fix\n');
  });

  it('leaves the message alone when the usage totals zero', () => {
    writeFileSync(msg, 'Fix\n');
    helper(['commit-trailer', msg], { stdin: JSON.stringify([{ model: 'x', inputTokens: 0, outputTokens: 0 }]) });
    assert.equal(readFileSync(msg, 'utf8'), 'Fix\n');
  });

  it('commit-tokens-enabled exits non-zero when the setting is off or absent', () => {
    assert.equal(helper(['commit-tokens-enabled'], { stdin: '{"commitTokenUsage":true}' }).code, 0);
    assert.notEqual(helper(['commit-tokens-enabled'], { stdin: '{"commitTokenUsage":false}' }).code, 0);
    assert.notEqual(helper(['commit-tokens-enabled'], { stdin: '{}' }).code, 0);
    // An unreachable dashboard yields an empty body: that must skip, not crash.
    assert.notEqual(helper(['commit-tokens-enabled'], { stdin: '' }).code, 0);
  });
});

describe('vdm-helper: misc', () => {
  it('urlencode handles the characters a branch name can contain', () => {
    assert.equal(helper(['urlencode', 'feat/my branch&x']).out, 'feat%2Fmy%20branch%26x');
  });

  it('parse-org-email extracts the address from organization_name', () => {
    const body = JSON.stringify({ organization_name: "user@example.com's Organization" });
    assert.equal(helper(['parse-org-email'], { stdin: body }).out, 'user@example.com');
  });

  it('parse-org-email yields nothing rather than failing on junk', () => {
    const r = helper(['parse-org-email'], { stdin: 'not json' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  });

  it('an unknown subcommand fails loudly instead of silently succeeding', () => {
    const r = helper(['no-such-command']);
    assert.notEqual(r.code, 0);
    assert.ok(r.err.includes('unknown helper command'));
  });

  it('usage-summary reports totals per model', () => {
    const usage = JSON.stringify([
      { model: 'claude-opus-4-1', inputTokens: 10, outputTokens: 5 },
      { model: 'claude-haiku-4-5', inputTokens: 1, outputTokens: 2 },
    ]);
    const out = helper(['usage-summary'], { stdin: usage }).out;
    assert.ok(out.includes('claude-opus-4-1'));
    assert.ok(out.includes('Grand Total: 18 tokens'), out);
  });

  it('usage-summary says so when there is nothing, rather than printing zeros', () => {
    assert.ok(helper(['usage-summary'], { stdin: '[]' }).out.includes('No token usage recorded'));
  });
});
