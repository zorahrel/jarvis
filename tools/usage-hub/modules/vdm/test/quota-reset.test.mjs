// Un reset delle quote deve riallineare card, picker e richieste in attesa.
// Importare dashboard aprirebbe porte e keychain: estraiamo le vere funzioni.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createAccountStateManager,
  createModelBlocks,
  isMisfiledModelCooldown,
  pickBestAccount,
} from '../lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// LF evita che i checkout Windows rompano l'estrazione delle funzioni.
const source = readFileSync(join(here, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');
function extract(name, isAsync = false) {
  const start = source.indexOf(`${isAsync ? 'async ' : ''}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in dashboard.mjs`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} closing brace not found`);
  return source.slice(start, end + 3);
}
const functions = [
  extract('updatePersistedState'),
  extract('updateAccountState'),
  extract('reconcileFromProbe'),
  extract('unblockSweep', true),
].join('\n');

const TOKEN = 'tok-finto';
const NAME = 'quota-reset-account';
const FP = 'quota-reset-fingerprint';
const PREFIX = 'anthropic-ratelimit-unified-';
const day = 24 * 3600_000;

function snapshot(overrides = {}) {
  const now = Date.now();
  return {
    utilization5h: 0,
    utilization7d: 1,
    resetAt: Math.floor(now / 1000) + 3600,
    resetAt7d: Math.floor(now / 1000) + 2 * 86400,
    limited: true,
    retryAfter: now + 2 * day,
    blockKind: 'model',
    updatedAt: now - 10 * 60_000,
    ...overrides,
  };
}

function probe({ status = 'allowed', u5h = 0, u7d = 0, omitted = [] } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const rateHeaders = {
    [`${PREFIX}status`]: status,
    [`${PREFIX}5h-utilization`]: String(u5h),
    [`${PREFIX}7d-utilization`]: String(u7d),
    [`${PREFIX}5h-reset`]: String(nowSec + 5 * 3600),
    [`${PREFIX}7d-reset`]: String(nowSec + 7 * 86400),
  };
  for (const key of omitted) delete rateHeaders[`${PREFIX}${key}`];
  return {
    status,
    fiveH: { status, utilization: u5h, reset: nowSec + 5 * 3600 },
    sevenD: { status, utilization: u7d, reset: nowSec + 7 * 86400 },
    rateHeaders,
    hasLimits: Object.keys(rateHeaders).length > 0,
  };
}

function build(initial = snapshot()) {
  const accountState = createAccountStateManager();
  const modelBlocks = createModelBlocks();
  const accounts = [{ token: TOKEN, name: NAME, fingerprint: FP }];
  const persistedState = { [FP]: { ...initial } };
  const wakeReasons = [];
  const probes = [];
  const saves = [];
  accountState.hydrate(TOKEN, NAME, initial);
  const history = { getHistory: () => [], load() {}, record() {} };
  let api;
  const dependencies = {
    accountState,
    modelBlocks,
    persistedState,
    isMisfiledModelCooldown,
    loadAllAccountTokens: () => accounts,
    getFingerprintFromToken: token => accounts.find(a => a.token === token).fingerprint,
    utilizationHistory: history,
    weeklyHistory: history,
    _sparkCache: {},
    saveHistoryToDisk() {},
    savePersistedState: () => saves.push(structuredClone(persistedState)),
    log() {},
    wakeCapHolders: reason => wakeReasons.push(reason),
    getRateLimitsForToken: async (token, fingerprint, options) => {
      probes.push({ token, fingerprint, options });
      api.reconcileFromProbe(token, probe());
    },
  };
  const names = Object.keys(dependencies);
  api = new Function(...names, `${functions}\nreturn { reconcileFromProbe, unblockSweep };`)(
    ...names.map(name => dependencies[name]),
  );
  return { ...api, accountState, modelBlocks, accounts, persistedState, wakeReasons, probes, saves };
}

function assertStillBlocked(harness, expectedRetryAfter, message) {
  assert.equal(harness.accountState.get(TOKEN).retryAfter, expectedRetryAfter, message);
  assert.equal(harness.accountState.get(TOKEN).limited, true, message);
  assert.equal(harness.persistedState[FP].retryAfter, expectedRetryAfter, message);
  assert.equal(harness.persistedState[FP].limited, true, message);
  assert.equal(pickBestAccount(harness.accounts, harness.accountState), null, message);
  assert.deepEqual(harness.wakeReasons, [], message);
}

test('a raw allowed 0/0 probe clears the old two-day account wall after a quota reset', () => {
  const initial = snapshot();
  assert.equal(isMisfiledModelCooldown(initial), false, 'the previous 100% week cannot prove recovery');
  const h = build(initial);
  assert.equal(pickBestAccount(h.accounts, h.accountState), null);

  h.reconcileFromProbe(TOKEN, probe());

  const live = h.accountState.get(TOKEN);
  assert.equal(live.retryAfter, 0, 'the newly observed free windows cancel the account wall');
  assert.equal(live.limited, false);
  assert.equal(live.blockKind, null);
  assert.equal(live.utilization5h, 0);
  assert.equal(live.utilization7d, 0);
  assert.equal(h.persistedState[FP].retryAfter, 0, 'a restart must not restore the cleared wall');
  assert.equal(h.persistedState[FP].limited, false);
  assert.equal(h.persistedState[FP].blockKind, null);
  assert.equal(h.persistedState[FP].utilization7d, 0);
  assert.ok(h.saves.some(saved => saved[FP].retryAfter === 0 && saved[FP].limited === false));
  assert.equal(pickBestAccount(h.accounts, h.accountState)?.token, TOKEN);
  assert.deepEqual(h.wakeReasons, [`${NAME} recovered`], 'held requests must be woken after recovery');
});

test('recovering plan windows preserves a separately tracked Opus pause', () => {
  const h = build();
  h.modelBlocks.mark(NAME, 'opus', 2 * 86400);
  const before = h.modelBlocks.toJSON();

  h.reconcileFromProbe(TOKEN, probe());

  assert.equal(pickBestAccount(h.accounts, h.accountState)?.token, TOKEN, 'other models can use the account');
  assert.deepEqual(h.modelBlocks.toJSON(), before, 'Haiku cannot lift the separate Opus allowance');
  assert.deepEqual([...h.modelBlocks.blockedNames('opus')], [NAME]);
  assert.deepEqual([...h.modelBlocks.blockedNames('sonnet')], []);
});

test('a free plan probe preserves active Extra Usage and permission cooldowns', () => {
  for (const blockKind of ['extra-usage', 'permission']) {
    const initial = snapshot({ blockKind });
    const h = build(initial);
    h.reconcileFromProbe(TOKEN, probe());
    assertStillBlocked(h, initial.retryAfter, blockKind);
    assert.equal(h.accountState.get(TOKEN).blockKind, blockKind);
    assert.equal(h.persistedState[FP].blockKind, blockKind);
  }
});

test('status-only and partial utilization readings cannot prove both plan windows are free', () => {
  const omissions = [
    ['5h-utilization', '7d-utilization', '5h-reset', '7d-reset'],
    ['5h-utilization'],
    ['7d-utilization'],
  ];
  for (const omitted of omissions) {
    const initial = snapshot({ utilization5h: 0, utilization7d: 0 });
    const h = build(initial);
    h.reconcileFromProbe(TOKEN, probe({ omitted }));
    assertStillBlocked(h, initial.retryAfter, `missing ${omitted.join(', ')}`);
  }
});

test('unknown, rejected and absent raw unified status cannot cancel a model cooldown', () => {
  for (const status of ['unknown', 'rejected', undefined]) {
    const initial = snapshot();
    const h = build(initial);
    const data = probe({ status: status ?? 'allowed' });
    if (status === undefined) delete data.rateHeaders[`${PREFIX}status`];
    h.reconcileFromProbe(TOKEN, data);
    assertStillBlocked(h, initial.retryAfter, `raw status ${String(status)}`);
  }
  const initial = snapshot();
  const h = build(initial);
  h.reconcileFromProbe(TOKEN, { status: 'allowed', rateHeaders: {} });
  assertStillBlocked(h, initial.retryAfter, 'a bare success carries no quota reading');
});

test('an allowed response with either plan window at 90% or more keeps the account cooldown', () => {
  for (const [u5h, u7d] of [[0.9, 0], [0, 0.9], [1, 0], [0, 1]]) {
    const initial = snapshot();
    const h = build(initial);
    h.reconcileFromProbe(TOKEN, probe({ u5h, u7d }));
    assertStillBlocked(h, initial.retryAfter, `${u5h}/${u7d}`);
  }
});

test('non-finite or negative utilization cannot prove a quota reset', () => {
  for (const invalid of [NaN, Infinity, -0.1]) {
    for (const [u5h, u7d] of [[invalid, 0], [0, invalid]]) {
      const initial = snapshot();
      const h = build(initial);
      h.reconcileFromProbe(TOKEN, probe({ u5h, u7d }));
      assertStillBlocked(h, initial.retryAfter, `invalid reading ${u5h}/${u7d}`);
    }
  }
});

test('a five-minute burst cooldown is preserved despite free plan windows', () => {
  const initial = snapshot({ retryAfter: Date.now() + 5 * 60_000 });
  const h = build(initial);
  h.reconcileFromProbe(TOKEN, probe());
  assertStillBlocked(h, initial.retryAfter, 'a short server wall is not a misfiled model allowance');
});

test('the unblock sweep probes a long model wall without a dashboard and skips unrelated active walls', async () => {
  const h = build();
  const ignored = [
    ['extra', 'extra-usage', 2 * day],
    ['permission', 'permission', 2 * day],
    ['burst', 'model', 5 * 60_000],
  ];
  for (const [name, blockKind, remaining] of ignored) {
    const token = `quota-reset-${name}`;
    h.accounts.push({ token, name, fingerprint: `fp-${name}` });
    h.accountState.hydrate(token, name, snapshot({ blockKind, retryAfter: Date.now() + remaining }));
  }
  h.accounts.push({ token: 'disabled-token', name: 'disabled', fingerprint: 'fp-disabled', disabled: true });
  h.accountState.hydrate('disabled-token', 'disabled', snapshot());
  h.accounts.push({ token: 'unknown-token', name: 'unknown', fingerprint: 'fp-unknown' });

  await h.unblockSweep();

  assert.deepEqual(h.probes, [{ token: TOKEN, fingerprint: FP, options: { allowProbe: true } }]);
  assert.equal(h.accountState.get(TOKEN).limited, false);
  assert.equal(h.persistedState[FP].retryAfter, 0);
  assert.equal(pickBestAccount(h.accounts.filter(a => a.token === TOKEN), h.accountState)?.token, TOKEN);
  assert.deepEqual(h.wakeReasons, [`${NAME} recovered`]);
});
