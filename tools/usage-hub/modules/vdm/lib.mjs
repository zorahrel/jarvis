// Van Damme-o-Matic  - Core Library
// Pure/testable functions extracted from dashboard.mjs.
// Zero dependencies, uses Node.js built-in modules only.

import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────
// Fingerprinting
// ─────────────────────────────────────────────────

export function getFingerprint(creds) {
  const token = creds?.claudeAiOauth?.accessToken || '';
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function getFingerprintFromToken(token) {
  return createHash('sha256').update(token || '').digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────
// Header building for proxy forwarding
// ─────────────────────────────────────────────────

// RFC 7230 §6.1: hop-by-hop headers that MUST NOT be forwarded by proxies.
// Also includes `connection` itself — plus any headers named in its value.
export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  // Not strictly hop-by-hop, but must be recalculated by the proxy:
  'host', 'content-length',
  // Strip accept-encoding: proxy must read/inspect error bodies (400, 401, etc.)
  // and compressed responses break the text-based error parsing. Localhost
  // traffic doesn't benefit from compression anyway.
  'accept-encoding',
  // Strip x-api-key: if Claude Code or another client forwards this header,
  // it can cause the API to bill a different account than the OAuth Bearer
  // token, leading to false "credit balance too low" 400 errors.
  'x-api-key',
]);

/**
 * Strip hop-by-hop headers from a headers object (for passthrough / raw forwarding).
 * Also strips any custom hop-by-hop headers declared in the Connection header.
 */
export function stripHopByHopHeaders(originalHeaders) {
  const connVal = originalHeaders['connection'] || originalHeaders['Connection'] || '';
  const extraHop = new Set(
    connVal.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
  const fwd = {};
  for (const [k, v] of Object.entries(originalHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || extraHop.has(lk)) continue;
    fwd[k] = v;
  }
  return fwd;
}

export function buildForwardHeaders(originalHeaders, token) {
  const fwd = stripHopByHopHeaders(originalHeaders);
  if (!token || typeof token !== 'string') {
    throw new Error(`Cannot forward request: token is ${token === null ? 'null' : typeof token}`);
  }
  fwd['authorization'] = `Bearer ${token}`;
  fwd['host'] = 'api.anthropic.com';
  // Ensure OAuth beta
  const betas = (fwd['anthropic-beta'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!betas.includes('oauth-2025-04-20')) betas.push('oauth-2025-04-20');
  fwd['anthropic-beta'] = betas.join(',');
  return fwd;
}

// ─────────────────────────────────────────────────
// Transient upstream failures
// ─────────────────────────────────────────────────

// Kept below VDM's 45-second request deadline. These retries are safe only
// before a response has been sent to the client; callers retry the same account
// because a Claude capacity incident is not an account failure.
export const UPSTREAM_RETRY_BACKOFF_MS = Object.freeze([1000, 2000, 4000]);

export function isRetryableUpstreamStatus(status) {
  return status === 529 || [500, 502, 503, 504].includes(status);
}

export function getUpstreamRetryPlan(status, retriesSoFar = 0) {
  if (!isRetryableUpstreamStatus(status) || retriesSoFar >= UPSTREAM_RETRY_BACKOFF_MS.length) return null;
  return { attempt: retriesSoFar + 1, delayMs: UPSTREAM_RETRY_BACKOFF_MS[retriesSoFar] };
}

// ─────────────────────────────────────────────────
// Account state management
// ─────────────────────────────────────────────────

export function createAccountStateManager() {
  const state = new Map();

  // Each rate-limit field is preserved independently when its header is absent.
  //
  // Response-level all-or-nothing is not enough: a 429 routinely carries
  // `unified-status: limited` with NO utilization headers. Treating that as a
  // reading writes 0% over a genuine 100%, which both blanks the card and — since
  // the usage cap reads the same field — quietly makes a capped account
  // selectable again. Absent header means "said nothing about this", never zero.
  const LIMIT_HEADERS = [
    'anthropic-ratelimit-unified-status',
    'anthropic-ratelimit-unified-5h-utilization',
    'anthropic-ratelimit-unified-7d-utilization',
    'anthropic-ratelimit-unified-5h-reset',
    'anthropic-ratelimit-unified-7d-reset',
  ];

  function update(token, name, headers, { preserveExtraUsageMarker = false } = {}) {
    const known = state.get(token);
    if (!LIMIT_HEADERS.some(k => headers[k] !== undefined)) {
      // Nothing at all about limits. Keep the whole last reading, including its
      // age — callers use `updatedAt` to decide when to re-probe, so refreshing it
      // here would suppress the probe that could actually learn something.
      // `expired` clears because a response did arrive, which is evidence the
      // token itself is live.
      if (known) state.set(token, { ...known, name, expired: false });
      return;
    }
    const status = headers['anthropic-ratelimit-unified-status'];
    // `?? previous` — not `|| 0`. A header that is present and reads "0" is a real
    // zero and must land; one that is absent must leave the previous value alone.
    const keep = (key, prev, parse) =>
      headers[key] !== undefined ? parse(headers[key]) : (prev ?? 0);
    const u5h = keep('anthropic-ratelimit-unified-5h-utilization', known?.utilization5h, parseFloat);
    const u7d = keep('anthropic-ratelimit-unified-7d-utilization', known?.utilization7d, parseFloat);
    const reset5h = keep('anthropic-ratelimit-unified-5h-reset', known?.resetAt, Number);
    const reset7d = keep('anthropic-ratelimit-unified-7d-reset', known?.resetAt7d, Number);
    // Preserve a still-active hard cooldown set by markLimited() from a real 429.
    // The unified-status header reflects only the account-wide/probe model (the
    // health probe uses Haiku), so an 'allowed' here does NOT mean a PER-MODEL
    // limit (e.g. the weekly Opus cap) has lifted. Blindly resetting retryAfter to
    // 0 on every 200 let the Haiku probe wipe the Opus cooldown, so `priority`
    // kept re-electing the account and hitting 429 on every request. A real 429's
    // explicit retry-after outranks a probe until it expires.
    const prev = state.get(token) || {};
    const now = Date.now();
    const activeCooldown = prev.retryAfter && prev.retryAfter > now ? prev.retryAfter : 0;
    // A plan-limit probe cannot test the separate third-party Extra Usage
    // allowance. Keep that marker after its short retry cooldown expires; a
    // real model response (which does not opt in here) is the evidence that can
    // clear it.
    const retainExtraUsageMarker = preserveExtraUsageMarker && prev.blockKind === 'extra-usage';
    state.set(token, {
      name,
      limited: status === 'limited' || activeCooldown > 0,
      expired: false,
      // A successful probe can refresh plan-window readings while a separate
      // per-account cooldown is still active (for example Extra Usage).
      blockKind: activeCooldown > 0
        ? (prev.blockKind || null)
        : (retainExtraUsageMarker ? 'extra-usage' : null),
      resetAt: reset5h,
      resetAt7d: reset7d,
      retryAfter: activeCooldown,
      utilization5h: u5h,
      utilization7d: u7d,
      updatedAt: now,
    });
  }

  /**
   * Seed the live state from a reading that was persisted to disk.
   *
   * This state is keyed by access token and starts empty on every restart, while
   * the durable copy is keyed by fingerprint — so without a bridge, the first
   * response after a restart has nothing to preserve against, and any field it
   * omits lands as 0. That is how a 100%-used account showed 0% until it happened
   * to receive a response carrying full headers, which a blocked account never
   * does.
   *
   * `updatedAt` comes from the snapshot, not from now: the reading is exactly as
   * old as it was on disk, and callers use its age to decide when to re-probe.
   */
  function hydrate(token, name, snapshot) {
    if (!token || !snapshot) return;
    state.set(token, {
      name,
      limited: !!snapshot.limited,
      expired: false,
      blockKind: snapshot.blockKind || null,
      resetAt: snapshot.resetAt || 0,
      resetAt7d: snapshot.resetAt7d || 0,
      retryAfter: snapshot.retryAfter || 0,
      utilization5h: snapshot.utilization5h || 0,
      utilization7d: snapshot.utilization7d || 0,
      updatedAt: snapshot.updatedAt || 0,
    });
  }

  function markLimited(token, name, retryAfterSec = 0, blockKind = null) {
    const prev = state.get(token) || {};
    state.set(token, {
      ...prev, name, limited: true,
      blockKind: blockKind ?? prev.blockKind ?? null,
      retryAfter: retryAfterSec ? Date.now() + retryAfterSec * 1000 : prev.retryAfter || 0,
      updatedAt: Date.now(),
    });
  }

  function markExpired(token, name) {
    const prev = state.get(token) || {};
    state.set(token, { ...prev, name, expired: true, updatedAt: Date.now() });
  }

  function clearBillingCooldown(token) {
    const prev = state.get(token);
    if (prev && prev.retryAfter > 0) {
      state.set(token, { ...prev, retryAfter: 0, blockKind: null, updatedAt: Date.now() });
    }
  }

  function get(token) {
    return state.get(token);
  }

  function entries() {
    return state.entries();
  }

  function clear() {
    state.clear();
  }

  function remove(token) {
    state.delete(token);
  }

  return { update, hydrate, markLimited, markExpired, clearBillingCooldown, get, entries, clear, remove };
}

// ─────────────────────────────────────────────────
// In-flight request tracking (for `balance` load-balancing)
// ─────────────────────────────────────────────────

/**
 * Tracks the number of concurrent in-flight requests per account.
 *
 * Keyed by account NAME (the credential file basename), NOT token/fingerprint:
 * a token refresh changes the fingerprint but keeps the name stable, so an
 * in-place refresh needs zero slot bookkeeping. `release` is underflow-guarded
 * and double-release safe, so the caller's single finally-release can never
 * drive a counter negative.
 */
export function createInflightTracker() {
  const counts = new Map();

  function acquire(name) {
    const n = (counts.get(name) || 0) + 1;
    counts.set(name, n);
    return n;
  }

  function release(name) {
    const n = counts.get(name) || 0;
    if (n <= 1) counts.delete(name);
    else counts.set(name, n - 1);
    return Math.max(0, n - 1);
  }

  function get(name) {
    return counts.get(name) || 0;
  }

  function total() {
    let sum = 0;
    for (const n of counts.values()) sum += n;
    return sum;
  }

  function snapshot() {
    return Object.fromEntries(counts);
  }

  return { acquire, release, get, total, snapshot };
}

/**
 * Concurrency limiter for `balance` mode: wraps an in-flight tracker with a
 * wait-for-slot queue and overflow-on-timeout, so the wait/overflow/wakeup
 * mechanics are unit-testable independently of the proxy.
 *
 * Timers and the clock are injectable for deterministic tests.
 *
 * acquire(pick, { cap, waitMs }):
 *   - pick() returns the currently-best candidate as `{ key, inflight, ...rest }`
 *     or null. It is re-invoked on every loop turn (in-flight counts change while
 *     waiting), so it must read live counts.
 *   - If the best candidate is under `cap`, acquires its slot and returns
 *     `{ ...candidate, overflow: false }`.
 *   - If every candidate is at the cap, waits up to `waitMs` for a freed slot
 *     (woken by release()), then OVERFLOWS onto the best candidate
 *     (`overflow: true`) rather than dropping. Returns null only when pick()
 *     returns null (genuine exhaustion).
 *
 * release(name) frees a slot and wakes the longest-waiting acquirer.
 */
export function createBalanceLimiter({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const inflight = createInflightTracker();
  const waiters = []; // [{ resolve, timer }] — FIFO

  function wake() {
    const w = waiters.shift();
    if (w) { clearTimer(w.timer); w.resolve(); }
  }

  function release(name) {
    inflight.release(name);
    wake();
  }

  async function acquire(pick, { cap, waitMs }) {
    const deadline = now() + waitMs;
    for (;;) {
      const best = pick();
      if (!best) return null;
      if (best.inflight < cap) {
        inflight.acquire(best.key);
        return { ...best, overflow: false };
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        inflight.acquire(best.key);
        return { ...best, overflow: true };
      }
      await new Promise(resolve => {
        const entry = { resolve, timer: null };
        entry.timer = setTimer(() => {
          const i = waiters.indexOf(entry);
          if (i !== -1) waiters.splice(i, 1);
          resolve();
        }, Math.min(remaining, 1000));
        waiters.push(entry);
      });
    }
  }

  return {
    inflight,
    acquire,
    release,
    get: (name) => inflight.get(name),
    total: () => inflight.total(),
    snapshot: () => inflight.snapshot(),
    waitingCount: () => waiters.length,
  };
}

// ─────────────────────────────────────────────────
// Usage caps
// ─────────────────────────────────────────────────

/**
 * Reset-aware utilization for one window.
 *
 * `utilization5h/7d` is whatever the last response header or probe reported. Once
 * the window's reset epoch has passed that number is stale by definition — the
 * window rolled over and usage restarted at zero. Reading it literally would keep
 * a capped account capped forever: it can't earn a fresh sample while it is being
 * skipped, so the stale value would be self-perpetuating.
 *
 * @param {object|undefined} acctState - entry from the account state manager
 * @param {'5h'|'7d'} window
 * @param {number} [now]
 * @returns {number} utilization on a 0..1 scale
 */
export function effectiveUtilization(acctState, window, now = Date.now()) {
  if (!acctState) return 0;
  const nowSec = Math.floor(now / 1000);
  if (window === '5h') {
    if (acctState.resetAt && acctState.resetAt < nowSec) return 0;
    return acctState.utilization5h || 0;
  }
  if (acctState.resetAt7d && acctState.resetAt7d < nowSec) return 0;
  return acctState.utilization7d || 0;
}

/**
 * Normalize a user-entered cap percentage to the 0..1 scale used by utilization.
 *
 * Anything outside (0, 100) means "no cap": 100 is what Anthropic already enforces,
 * and 0 would mean "never use this account" — which is what the `.disabled` sidecar
 * is for, and conflating the two would make an empty input silently mute an account.
 *
 * @returns {number|null} 0..1, or null when no cap applies
 */
export function normalizeCapPercent(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n >= 100) return null;
  return n / 100;
}

/**
 * Resolve the caps in force for one account: a per-account override wins over the
 * global setting, field by field, so an account can cap only its weekly window and
 * inherit the global 5h cap.
 *
 * @param {object|null} own    - per-account override, e.g. { fiveH: 40, sevenD: null }
 * @param {object|null} global - global caps, same shape, in percent
 * @returns {{fiveH: number|null, sevenD: number|null}} on the 0..1 scale
 */
export function resolveAccountCaps(own, global) {
  const pick = (k) => {
    const v = own?.[k];
    if (v === null || v === undefined || v === '') return normalizeCapPercent(global?.[k]);
    return normalizeCapPercent(v);
  };
  return { fiveH: pick('fiveH'), sevenD: pick('sevenD') };
}

/**
 * Is this account past a cap the user set?
 *
 * Reads the caps already resolved onto the account object (`capFiveH` / `capSevenD`,
 * 0..1 or null) — the same shape as `priority` and `disabled`, resolved once by the
 * loader rather than threaded through every picker signature.
 */
export function isOverUsageCap(account, stateManager, now = Date.now()) {
  const c5 = account?.capFiveH ?? null;
  const c7 = account?.capSevenD ?? null;
  if (c5 === null && c7 === null) return false;
  const acctState = stateManager.get(account.token);
  if (c5 !== null && effectiveUtilization(acctState, '5h', now) >= c5) return true;
  if (c7 !== null && effectiveUtilization(acctState, '7d', now) >= c7) return true;
  return false;
}

/**
 * Which caps this account is currently over, and when it comes back — the window
 * reset epoch of whichever capped window frees up last.
 *
 * Returns `freeAt: 0` when a capped window has no known reset time, so callers can
 * tell "back at 03:10" apart from "no idea when".
 *
 * @returns {{over5h: boolean, over7d: boolean, over: boolean, freeAt: number}} freeAt in ms
 */
export function usageCapState(account, stateManager, now = Date.now()) {
  const c5 = account?.capFiveH ?? null;
  const c7 = account?.capSevenD ?? null;
  const acctState = stateManager.get(account?.token);
  const over5h = c5 !== null && effectiveUtilization(acctState, '5h', now) >= c5;
  const over7d = c7 !== null && effectiveUtilization(acctState, '7d', now) >= c7;
  let freeAt = 0;
  if (over5h || over7d) {
    const resets = [];
    if (over5h) resets.push((acctState?.resetAt || 0) * 1000);
    if (over7d) resets.push((acctState?.resetAt7d || 0) * 1000);
    // Unknown reset (0) poisons the answer: we can't promise a time we don't have.
    freeAt = resets.some(r => !r) ? 0 : Math.max(...resets);
  }
  return { over5h, over7d, over: over5h || over7d, freeAt };
}

/**
 * The one predicate every picker filters on. Kept in one place so a new exclusion
 * reason can't be added to five filters and forgotten in the sixth.
 */
export function isSelectableAccount(a, stateManager, excludeTokens = new Set(), now = Date.now()) {
  return !excludeTokens.has(a.token)
    && !a.disabled
    && isAccountAvailable(a.token, a.expiresAt, stateManager, now)
    && !isOverUsageCap(a, stateManager, now);
}

// ─────────────────────────────────────────────────
// Per-model cooldowns (LOCAL-PATCHES 2026-09-25)
// ─────────────────────────────────────────────────
//
// A 429 can be a wall on ONE model (the weekly Opus cap, the 1M-context variant)
// while the account's plan windows still have room: Anthropic keeps serving the
// other models there. Filed as an account-wide cooldown, it took account-a@example.com
// out of rotation for every model and every session for 5.2 days, with 5h at 2%
// and 7d at 0%. These pieces scope such a wall to the model that hit it.

/** Below this a wall is a burst or a window, not a model's allowance (those reset with the week). */
const MODEL_LIMIT_MIN_RETRY_SEC = 3600;
/** A stored reading older than this can't vouch for the windows being free. */
const MODEL_LIMIT_FRESH_MS = 30 * 60 * 1000;
/** Windows at or above this are the account's own limit, whatever the retry-after. */
const WINDOW_FULL = 0.9;
/**
 * How often one request tests a paused model again. A 429 can claim days and be wrong:
 * the one that froze account-a@example.com claimed 5.2 days, and opus[1m] answered there
 * half an hour later.
 */
export const MODEL_BLOCK_RETRY_MS = 10 * 60 * 1000;

/**
 * The allowance a request draws on, as a per-model limit sees it: the model family
 * ("opus", "sonnet", "haiku", "fable"), plus "-1m" when the 1M-context beta is on.
 * "" when the body names no model: such a request is never held back by a model block.
 * Reads the head of the body first: Claude Code puts `model` first, and a 1M-context
 * body can be megabytes.
 */
export function requestModelKey(body, headers = {}) {
  if (!body || !body.length) return '';
  let model = '';
  try {
    model = (body.toString('utf8', 0, Math.min(body.length, 4096)).match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || '';
    if (!model) model = String(JSON.parse(body.toString('utf8'))?.model || '');
  } catch {
    return '';
  }
  const family = (model.toLowerCase().match(/opus|sonnet|haiku|fable/) || [''])[0];
  if (!family) return '';
  const oneM = /context-1m/i.test(String(headers['anthropic-beta'] || '')) || /\[1m\]/i.test(model);
  return oneM ? `${family}-1m` : family;
}

/**
 * Whether a 429 is a wall on the requested model rather than on the account: a long
 * retry-after while the plan windows are below 90%. The windows are read from the 429
 * itself when it carries them, else from a stored reading at most 30 minutes old; with
 * neither the answer is no, and the account-wide rule applies as before.
 */
export function isPerModel429({ retryAfter, headers = {}, state, now = Date.now() }) {
  if (!(retryAfter >= MODEL_LIMIT_MIN_RETRY_SEC)) return false;
  const fresh = !!state?.updatedAt && now - state.updatedAt < MODEL_LIMIT_FRESH_MS;
  const read = (header, stored) => {
    const v = parseFloat(headers[header]);
    if (Number.isFinite(v)) return v;
    return fresh ? (stored || 0) : null;
  };
  const u5 = read('anthropic-ratelimit-unified-5h-utilization', state?.utilization5h);
  const u7 = read('anthropic-ratelimit-unified-7d-utilization', state?.utilization7d);
  if (u5 === null && u7 === null) return false;
  return Math.max(u5 ?? 0, u7 ?? 0) < WINDOW_FULL;
}

/**
 * Per-model cooldowns, keyed by account NAME (it survives a token refresh, a
 * fingerprint does not): `{ [name]: { [modelKey]: untilMs } }`, plain JSON in and out
 * so the dashboard can persist it as it is.
 */
export function createModelBlocks(initial = {}) {
  const blocks = new Map(Object.entries(initial || {}).map(([name, m]) => [name, { ...m }]));
  // When each pause was last tried, in memory only: after a restart the first request tests it.
  const tried = new Map();
  const slot = (name, key) => `${name}\u0000${key}`;
  return {
    mark(name, key, retryAfterSec, now = Date.now()) {
      if (!name || !key) return;
      blocks.set(name, { ...(blocks.get(name) || {}), [key]: now + retryAfterSec * 1000 });
      tried.set(slot(name, key), now); // the 429 itself was the try
    },
    clear(name, key) {
      const m = blocks.get(name);
      if (!m || !(key in m)) return false;
      delete m[key];
      if (!Object.keys(m).length) blocks.delete(name);
      tried.delete(slot(name, key));
      return true;
    },
    /** Whether a request for this model may test the paused account again: one every `everyMs`. */
    probeDue(name, key, now = Date.now(), everyMs = MODEL_BLOCK_RETRY_MS) {
      return now - (tried.get(slot(name, key)) ?? -Infinity) >= everyMs;
    },
    markProbe(name, key, now = Date.now()) {
      tried.set(slot(name, key), now);
    },
    until(name, key, now = Date.now()) {
      const u = blocks.get(name)?.[key] || 0;
      return u > now ? u : 0;
    },
    blockedNames(key, now = Date.now()) {
      const out = new Set();
      if (!key) return out;
      for (const [name, m] of blocks) if ((m[key] || 0) > now) out.add(name);
      return out;
    },
    /** The models an account is paused for, soonest back first. */
    active(name, now = Date.now()) {
      return Object.entries(blocks.get(name) || {})
        .filter(([, until]) => until > now)
        .map(([model, until]) => ({ model, until }))
        .sort((a, b) => a.until - b.until);
    },
    toJSON(now = Date.now()) {
      const out = {};
      for (const [name, m] of blocks) {
        const live = Object.fromEntries(Object.entries(m).filter(([, until]) => until > now));
        if (Object.keys(live).length) out[name] = live;
      }
      return out;
    },
  };
}

/**
 * A cooldown persisted before the fix that was really a model's wall: kind 'model',
 * account-wide, at least an hour left, plan windows free. Dropped at startup; the next
 * request for that model files it again, this time where it belongs.
 */
export function isMisfiledModelCooldown(ps, now = Date.now()) {
  return ps?.blockKind === 'model'
    && (ps.retryAfter || 0) - now >= MODEL_LIMIT_MIN_RETRY_SEC * 1000
    && Math.max(ps.utilization5h || 0, ps.utilization7d || 0) < WINDOW_FULL;
}

// ─────────────────────────────────────────────────
// Account availability & selection
// ─────────────────────────────────────────────────

export function isAccountAvailable(token, expiresAt, stateManager, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const acctState = stateManager.get(token);

  // Token expired according to saved expiresAt
  if (expiresAt && expiresAt < now) return false;
  // Marked expired by a 401
  if (acctState?.expired) return false;
  // Limited: unavailable if ANY active cooldown hasn't passed yet
  if (acctState?.limited) {
    if (acctState.retryAfter && acctState.retryAfter >= now) return false;   // billing cooldown active
    if (acctState.resetAt && acctState.resetAt >= nowSec) return false;      // 5h rate-limit active
    return true; // all cooldowns expired
  }
  return true;
}

/**
 * The first instant a limited account passes isAccountAvailable again: after its
 * cooldown AND after the second of its window reset (that check reads
 * `resetAt >= nowSec`). 0 when neither is known. A hold that ends on the cooldown
 * alone ended one second early, and every parked request got a 429 at the very
 * reset it was waiting for (LOCAL-PATCHES 2026-09-25).
 */
export function accountFreeAt(st) {
  const afterCooldown = st?.retryAfter ? st.retryAfter + 1 : 0;
  const afterReset = st?.resetAt ? (st.resetAt + 1) * 1000 : 0;
  return Math.max(afterCooldown, afterReset);
}

export function scoreAccount(token, stateManager) {
  const acctState = stateManager.get(token);
  if (!acctState) return 0; // unknown = fresh, try first
  return acctState.utilization5h || 0;
}

export function pickBestAccount(accounts, stateManager, excludeTokens = new Set()) {
  const candidates = accounts
    .filter(a => isSelectableAccount(a, stateManager, excludeTokens))
    .map(a => ({ ...a, score: scoreAccount(a.token, stateManager) }))
    .sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

export function pickDrainFirst(accounts, stateManager, excludeTokens = new Set()) {
  const candidates = accounts
    .filter(a => isSelectableAccount(a, stateManager, excludeTokens))
    .map(a => ({ ...a, score: scoreAccount(a.token, stateManager) }))
    .sort((a, b) => b.score - a.score); // highest utilization first
  return candidates[0] || null;
}

/**
 * Score for the "conserve" strategy.
 * Concentrates usage on accounts whose windows are already active.
 * Weekly utilization is primary (scarce resource  - resets once/week).
 * 5hr utilization is secondary tiebreaker.
 * Untouched accounts (0% on both) score 0  - their windows stay dormant.
 */
export function scoreAccountConserve(token, stateManager) {
  const acctState = stateManager.get(token);
  if (!acctState) return 0; // unknown = untouched, preserve it
  const w7d = acctState.utilization7d || 0;
  const w5h = acctState.utilization5h || 0;
  // Weekly dominates (×100), 5hr is tiebreaker (×1)
  return w7d * 100 + w5h;
}

export function pickConserve(accounts, stateManager, excludeTokens = new Set()) {
  const candidates = accounts
    .filter(a => isSelectableAccount(a, stateManager, excludeTokens))
    .map(a => ({ ...a, score: scoreAccountConserve(a.token, stateManager) }))
    .sort((a, b) => b.score - a.score); // highest combined utilization first
  return candidates[0] || null;
}

/**
 * "reset-first" (usa-o-perdi): tra gli account disponibili sceglie quello il cui
 * limite settimanale si azzera prima, perché la sua quota avanzata al reset è persa.
 * Esclude chi ha la settimana piena; reset sconosciuto = in fondo. Pareggio: 5h più bassa.
 */
export function pickResetFirst(accounts, stateManager, excludeTokens = new Set(), now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const resetOf = (st) => (st?.resetAt7d && st.resetAt7d > nowSec ? st.resetAt7d : Infinity);
  const candidates = accounts
    .filter(a => isSelectableAccount(a, stateManager, excludeTokens, now))
    .filter(a => (stateManager.get(a.token)?.utilization7d || 0) < WINDOW_FULL)
    .map(a => ({ ...a, reset: resetOf(stateManager.get(a.token)), score: scoreAccount(a.token, stateManager) }))
    .sort((a, b) => (a.reset - b.reset) || (a.score - b.score));
  return candidates[0] || null;
}

/**
 * Last-resort pick: try an account even if state says it's limited, in case that
 * state is stale.
 *
 * Skips user-disabled accounts and accounts over their usage cap. Both are explicit
 * user decisions, and they outrank a guess about stale state — a cap that the
 * last-resort path walks straight through would never actually hold anything back.
 * `stateManager` is optional so the older two-argument call still works, but without
 * it the cap can't be evaluated and won't be enforced.
 */
export function pickAnyUntried(accounts, excludeTokens, stateManager = null, now = Date.now()) {
  return accounts.find(a =>
    !excludeTokens.has(a.token)
    && !a.disabled
    && !(stateManager && isOverUsageCap(a, stateManager, now))
  ) || null;
}

/**
 * Priority of an account for the `priority` (failover) strategy.
 * Higher number = more preferred. Unset / non-numeric defaults to 0.
 */
export function accountPriority(account) {
  const p = account?.priority;
  return Number.isFinite(p) ? p : 0;
}

/**
 * Pick the highest-priority available account (`priority` / failover strategy).
 *
 * Among available (not limited/expired/cooling-down), non-excluded accounts,
 * returns the one with the highest `priority`, tie-broken by lowest 5h
 * utilization and then account name (for deterministic ordering). Because it
 * always returns the globally most-preferred available account, a higher-priority
 * account that comes back online is picked up automatically on the next request.
 * Returns null when no account is available.
 *
 * @param {Array}  accounts      - account objects { name, token, expiresAt, priority? }
 * @param {object} stateManager  - account state manager
 * @param {Set}    excludeTokens - tokens to skip (already tried this request)
 * @param {number} [now]         - current time (for testing cooldown windows)
 */
export function pickByPriority(accounts, stateManager, excludeTokens = new Set(), now = Date.now()) {
  const candidates = accounts
    .filter(a => isSelectableAccount(a, stateManager, excludeTokens, now))
    .map(a => ({ ...a, prio: accountPriority(a), score: scoreAccount(a.token, stateManager) }))
    .sort((a, b) =>
      (b.prio - a.prio) ||           // higher priority first
      (a.score - b.score) ||         // then lowest 5h utilization
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) // then name, for determinism
    );
  return candidates[0] || null;
}

/**
 * Pick the least-loaded available account for concurrency load-balancing (`balance` mode).
 *
 * Among accounts that are available (not limited/expired/cooling-down) and not excluded,
 * returns the one with the lowest in-flight request count, tie-broken by 5h utilization
 * (prefer the less-used window). The returned `overCap` flag is true when even the
 * least-loaded account is already at or above `cap` — the caller decides whether to wait
 * for a slot or overflow.
 *
 * @param {Array}  accounts        - account objects { name, token, expiresAt, ... }
 * @param {object} inflightTracker - createInflightTracker() instance (keyed by account name)
 * @param {object} stateManager    - account state manager
 * @param {number} cap             - max concurrent in-flight per account
 * @param {Set}    excludeTokens   - tokens to skip (already tried this request)
 * @param {number} [now]           - current time (for testing cooldown windows)
 * @returns {{ account: object, inflight: number, overCap: boolean } | null}
 */
export function pickLeastLoaded(accounts, inflightTracker, stateManager, cap, excludeTokens = new Set(), now = Date.now()) {
  const candidates = accounts
    .filter(a => isSelectableAccount(a, stateManager, excludeTokens, now))
    .map(a => ({
      account: a,
      inflight: inflightTracker.get(a.name),
      score: scoreAccount(a.token, stateManager),
    }))
    .sort((x, y) => (x.inflight - y.inflight) || (x.score - y.score));

  const best = candidates[0];
  if (!best) return null;
  return { account: best.account, inflight: best.inflight, overCap: best.inflight >= cap };
}

// ─────────────────────────────────────────────────
// Rotation strategies
// ─────────────────────────────────────────────────

export const ROTATION_STRATEGIES = {
  sticky:        { label: 'Sticky',        desc: 'Stay on current account, only switch on rate limit' },
  conserve:      { label: 'Conserve',      desc: 'Max out active accounts first  - untouched windows stay dormant' },
  'round-robin': { label: 'Round-robin',   desc: 'Rotate to lowest-utilization account on a timer' },
  spread:        { label: 'Spread',        desc: 'Always pick lowest utilization (switches often)' },
  'drain-first': { label: 'Drain first',   desc: 'Use highest 5hr-utilization account first' },
  balance:       { label: 'Balance',       desc: 'Spread concurrent requests across accounts, capped per account' },
  priority:      { label: 'Priority',      desc: 'Prefer your highest-priority account; fail over on limit, switch back when it recovers' },
  'reset-first': { label: 'Reset first',   desc: 'Use the account whose weekly limit resets soonest, so its leftover quota is not lost' },
};

export const ROTATION_INTERVALS = [15, 30, 60, 120]; // minutes

/**
 * Pick the proactive account based on rotation strategy.
 * Returns null if the current account should be kept (sticky / timer not elapsed).
 *
 * @param {object} opts
 * @param {string} opts.strategy - 'sticky' | 'conserve' | 'round-robin' | 'spread' | 'drain-first' | 'priority'
 * @param {number} opts.intervalMin - rotation interval in minutes (for round-robin)
 * @param {string|null} opts.currentToken - token currently in the keychain
 * @param {number} opts.lastRotationTime - timestamp of last proactive rotation
 * @param {Array} opts.accounts - all account objects
 * @param {object} opts.stateManager - account state manager
 * @param {Set} opts.excludeTokens - tokens to exclude
 * @param {number} [opts.now] - current time (for testing)
 * @returns {{ account: object|null, rotated: boolean }}
 */
export function pickByStrategy(opts) {
  const {
    strategy, intervalMin, currentToken, lastRotationTime,
    accounts, stateManager, excludeTokens = new Set(),
    now = Date.now(),
  } = opts;

  // For all strategies: if current account is unavailable, always pick a replacement.
  // Being over its usage cap counts as unavailable, so even `sticky` moves off an
  // account that has hit the ceiling instead of sitting on it.
  const currentAcct = accounts.find(a => a.token === currentToken);
  const currentAvailable = currentToken && currentAcct &&
    isAccountAvailable(currentToken, currentAcct.expiresAt, stateManager, now) &&
    !isOverUsageCap(currentAcct, stateManager, now);

  if (!currentAvailable) {
    // Must switch  - pick a replacement. Honor the priority ordering when that
    // strategy is active, otherwise fall back to lowest utilization as a safe default.
    const best = strategy === 'priority'
      ? pickByPriority(accounts, stateManager, excludeTokens, now)
      : pickBestAccount(accounts, stateManager, excludeTokens);
    return { account: best, rotated: !!best };
  }

  switch (strategy) {
    case 'sticky':
      // Never proactively switch  - keep current
      return { account: null, rotated: false };

    case 'conserve': {
      // Pick account with highest weekly utilization (windows already active)
      // Untouched accounts stay dormant  - their windows don't start
      const conserved = pickConserve(accounts, stateManager, excludeTokens);
      if (conserved && conserved.token !== currentToken) {
        return { account: conserved, rotated: true };
      }
      return { account: null, rotated: false };
    }

    case 'round-robin': {
      const elapsed = now - (lastRotationTime || 0);
      const intervalMs = (intervalMin || 60) * 60 * 1000;
      if (elapsed < intervalMs) {
        return { account: null, rotated: false }; // timer not elapsed
      }
      const best = pickBestAccount(accounts, stateManager, excludeTokens);
      if (best && best.token !== currentToken) {
        return { account: best, rotated: true };
      }
      return { account: null, rotated: false }; // already on best
    }

    case 'spread':
      // Always pick lowest utilization (current behavior)
      const lowest = pickBestAccount(accounts, stateManager, excludeTokens);
      if (lowest && lowest.token !== currentToken) {
        return { account: lowest, rotated: true };
      }
      return { account: null, rotated: false };

    case 'drain-first': {
      const drain = pickDrainFirst(accounts, stateManager, excludeTokens);
      if (drain && drain.token !== currentToken) {
        return { account: drain, rotated: true };
      }
      return { account: null, rotated: false };
    }

    case 'reset-first': {
      const soonest = pickResetFirst(accounts, stateManager, excludeTokens, now);
      if (soonest && soonest.token !== currentToken) {
        return { account: soonest, rotated: true };
      }
      return { account: null, rotated: false };
    }

    case 'priority': {
      // Always run on the highest-priority available account. When the current
      // account is available but a more-preferred one has recovered, switch up.
      const preferred = pickByPriority(accounts, stateManager, excludeTokens, now);
      if (preferred && preferred.token !== currentToken) {
        return { account: preferred, rotated: true };
      }
      return { account: null, rotated: false };
    }

    default:
      return { account: null, rotated: false };
  }
}

// ─────────────────────────────────────────────────
// Earliest reset time
// ─────────────────────────────────────────────────

export function getEarliestReset(stateManager) {
  let earliest = Infinity;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [, acctState] of stateManager.entries()) {
    // Check 5h reset
    if (acctState.resetAt && acctState.resetAt > nowSec && acctState.resetAt < earliest) {
      earliest = acctState.resetAt;
    }
    // Check 7d reset
    if (acctState.resetAt7d && acctState.resetAt7d > nowSec && acctState.resetAt7d < earliest) {
      earliest = acctState.resetAt7d;
    }
  }
  if (earliest === Infinity) return 'unknown';
  const d = new Date(earliest * 1000);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * A wait, in the units a human reads it in. Seconds stop being readable somewhere
 * around a minute, and a hold can now run for a day — "waiting up to 86400s" is a
 * number you have to do arithmetic on before you know what the daemon is doing.
 */
export function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 90) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}min`;
  const hours = ms / 3_600_000;
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}h`;
}

// ─────────────────────────────────────────────────
// Probe cost tracking (rolling 7-day window)
// ─────────────────────────────────────────────────

const PROBE_INPUT_TOKENS = 11;
const PROBE_OUTPUT_TOKENS = 5;
const PROBE_LOG_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createProbeTracker(maxAge = PROBE_LOG_MAX_AGE) {
  const log = [];

  function record(ts = Date.now()) {
    log.push({ ts });
    // Prune entries older than max age
    const cutoff = Date.now() - maxAge;
    while (log.length && log[0].ts < cutoff) log.shift();
  }

  function getStats() {
    const cutoff = Date.now() - maxAge;
    const recent = log.filter(p => p.ts >= cutoff);
    const count = recent.length;
    return {
      probeCount7d: count,
      inputTokens: count * PROBE_INPUT_TOKENS,
      outputTokens: count * PROBE_OUTPUT_TOKENS,
    };
  }

  function getLog() {
    return log;
  }

  function load(entries) {
    if (!entries || !entries.length) return;
    const cutoff = Date.now() - maxAge;
    const valid = entries.filter(e => e.ts >= cutoff);
    log.length = 0;
    for (const e of valid) log.push(e);
  }

  function toJSON() {
    return log.slice();
  }

  return { record, getStats, getLog, load, toJSON };
}

// Re-export constants for tests
export { PROBE_INPUT_TOKENS, PROBE_OUTPUT_TOKENS, PROBE_LOG_MAX_AGE };

// ─────────────────────────────────────────────────
// Usage attribution & list pricing
// ─────────────────────────────────────────────────

// List price per million tokens, USD. Cache reads are ~0.1x input and cache
// writes ~1.25x input (5-minute TTL) — for a Claude Code session, where each turn
// re-reads the whole context as a cache read, ignoring them understates real
// consumption by roughly an order of magnitude.
export const MODEL_PRICING_USD = {
  'claude-fable-5':  { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5':   { input: 5,  output: 25 },
  'claude-opus-4-8': { input: 5,  output: 25 },
  'claude-opus-4-7': { input: 5,  output: 25 },
  'claude-opus-4-6': { input: 5,  output: 25 },
  'claude-opus-4-5': { input: 5,  output: 25 },
  'claude-sonnet-5': { input: 3,  output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5':  { input: 1, output: 5 },
};
const MODEL_PRICING_DEFAULT = { input: 5, output: 25 };
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function pricingFor(model) {
  if (!model) return MODEL_PRICING_DEFAULT;
  // Longest prefix wins, so `claude-opus-4-8` isn't matched by a shorter key.
  let best = null;
  for (const key of Object.keys(MODEL_PRICING_USD)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? MODEL_PRICING_USD[best] : MODEL_PRICING_DEFAULT;
}

/** Every token the account was charged for, cache included. */
export function billableTokens(r) {
  return (r.inputTokens || 0) + (r.outputTokens || 0)
    + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
}

/**
 * What this traffic would have cost at API list prices, in USD.
 *
 * This is NOT what the account actually costs — these are subscription accounts,
 * billed at a flat monthly rate. Read it as "the value I pulled out of the
 * subscription this window", which is the useful comparison, and label it that
 * way anywhere it's shown.
 */
export function listCostUsd(r) {
  const p = pricingFor(r.model);
  return ((r.inputTokens || 0) / 1e6) * p.input
    + ((r.outputTokens || 0) / 1e6) * p.output
    + ((r.cacheReadTokens || 0) / 1e6) * p.input * CACHE_READ_MULTIPLIER
    + ((r.cacheCreationTokens || 0) / 1e6) * p.input * CACHE_WRITE_MULTIPLIER;
}

export const ATTRIBUTION_BANDS = 40; // slices per window — enough to read, cheap to draw

/**
 * Build the chronological picture for one account and one window.
 *
 * Returns per-slice: my measured tokens, my list-price value, and — where
 * utilization samples cover the slice — how much of the window's utilization rise
 * happened in it and whether this proxy was responsible.
 */
export function attributionForWindow(records, samples, { from, to, key }) {
  const span = to - from;
  const width = span / ATTRIBUTION_BANDS;
  const bands = Array.from({ length: ATTRIBUTION_BANDS }, (_, i) => ({
    from: from + i * width,
    to: from + (i + 1) * width,
    myTokens: 0,
    myCostUsd: 0,
    requests: 0,
    deltaUtil: null,   // null = no utilization samples cover this slice
  }));

  let myTokens = 0, myCostUsd = 0, requests = 0;
  // Keep the four token classes separate as well as exposing their billable
  // total. A large cache-read total is normal for a long coding session, but a
  // bare total makes it look as if a new account somehow arrived pre-spent.
  const tokenBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const byModel = {};
  for (const r of records) {
    if (r.ts < from || r.ts > to) continue;
    const tok = billableTokens(r);
    const cost = listCostUsd(r);
    myTokens += tok; myCostUsd += cost; requests++;
    tokenBreakdown.inputTokens += r.inputTokens || 0;
    tokenBreakdown.outputTokens += r.outputTokens || 0;
    tokenBreakdown.cacheReadTokens += r.cacheReadTokens || 0;
    tokenBreakdown.cacheCreationTokens += r.cacheCreationTokens || 0;
    const m = byModel[r.model || 'unknown'] || (byModel[r.model || 'unknown'] = { tokens: 0, costUsd: 0, requests: 0 });
    m.tokens += tok; m.costUsd += cost; m.requests++;
    const idx = Math.min(ATTRIBUTION_BANDS - 1, Math.floor((r.ts - from) / width));
    bands[idx].myTokens += tok;
    bands[idx].myCostUsd += cost;
    bands[idx].requests++;
  }

  // Attribute utilization rises to slices. A drop means the window rolled over
  // mid-sample; treat it as zero rather than as negative external usage.
  let covered = 0;
  const inWindow = samples.filter(s => s.ts >= from && s.ts <= to).sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < inWindow.length; i++) {
    const prev = inWindow[i - 1], cur = inWindow[i];
    const rise = Math.max(0, (cur[key] || 0) - (prev[key] || 0));
    const idx = Math.min(ATTRIBUTION_BANDS - 1, Math.floor((cur.ts - from) / width));
    bands[idx].deltaUtil = (bands[idx].deltaUtil || 0) + rise;
  }
  for (const b of bands) if (b.deltaUtil !== null) covered++;

  // Split the measured rise: a slice where utilization climbed with no traffic
  // through this proxy is someone else on the account.
  let riseMine = 0, riseExternal = 0;
  for (const b of bands) {
    if (b.deltaUtil === null || b.deltaUtil === 0) continue;
    if (b.myTokens > 0) riseMine += b.deltaUtil;
    else riseExternal += b.deltaUtil;
  }
  const riseTotal = riseMine + riseExternal;

  return {
    myTokens,
    myCostUsd,
    requests,
    tokenBreakdown,
    byModel,
    bands,
    // Coverage is what keeps this honest: with few samples the split below is
    // computed from a sliver of the window, and the UI says so instead of
    // presenting it as the whole picture.
    coverage: covered / ATTRIBUTION_BANDS,
    measuredRise: riseTotal,
    externalShare: riseTotal > 0 ? riseExternal / riseTotal : null,
  };
}

// ─────────────────────────────────────────────────
// Utilization history (for sparklines & velocity)
// ─────────────────────────────────────────────────

const HISTORY_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const HISTORY_MIN_INTERVAL = 2 * 60 * 1000; // 2 min between points

export { HISTORY_MAX_AGE, HISTORY_MIN_INTERVAL };

export function createUtilizationHistory(maxAge = HISTORY_MAX_AGE, minInterval = HISTORY_MIN_INTERVAL) {
  // Map<fingerprint, Array<{ ts, u5h, u7d }>>
  const history = new Map();

  function record(fingerprint, u5h, u7d, ts = Date.now()) {
    if (!history.has(fingerprint)) history.set(fingerprint, []);
    const arr = history.get(fingerprint);
    // If the last entry is too recent, update it in place (keeps latest value)
    if (arr.length > 0 && ts - arr[arr.length - 1].ts < minInterval) {
      arr[arr.length - 1] = { ts, u5h, u7d };
    } else {
      arr.push({ ts, u5h, u7d });
    }
    // Prune entries older than the window
    const cutoff = ts - maxAge;
    while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
  }

  function getHistory(fingerprint) {
    return history.get(fingerprint) || [];
  }

  /**
   * Calculate utilization velocity (change per hour) for the 5h window.
   * Uses only the last 30 minutes of data to reflect current usage rate,
   * not stale history from hours ago that inflates the slope.
   * Returns null if insufficient data.
   */
  function getVelocity(fingerprint) {
    const arr = history.get(fingerprint);
    if (!arr || arr.length < 2) return null;
    // Use recent window (last 30 min) for velocity, not entire history
    const recentCutoff = Date.now() - 30 * 60 * 1000;
    const recent = arr.filter(e => e.ts >= recentCutoff);
    if (recent.length < 2) return null;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const timeDeltaHrs = (last.ts - first.ts) / (1000 * 60 * 60);
    if (timeDeltaHrs < 0.16) return null; // need at least ~10 min of recent data
    const utilizationDelta = last.u5h - first.u5h;
    return utilizationDelta / timeDeltaHrs; // change per hour (0-1 scale)
  }

  /**
   * Predict minutes until 5h utilization reaches 1.0 (rate limit).
   * Returns null if velocity is <= 0 or insufficient data.
   */
  function predictMinutesToLimit(fingerprint) {
    const arr = history.get(fingerprint);
    if (!arr || arr.length < 2) return null;
    const velocity = getVelocity(fingerprint);
    if (!velocity || velocity <= 0) return null;
    const current = arr[arr.length - 1].u5h;
    const remaining = 1.0 - current;
    if (remaining <= 0) return 0;
    return Math.round((remaining / velocity) * 60); // minutes
  }

  function getAllFingerprints() {
    return [...history.keys()];
  }

  function load(fingerprint, entries) {
    if (!entries || !entries.length) {
      history.set(fingerprint, []);
      return;
    }
    const cutoff = Date.now() - maxAge;
    const valid = entries.filter(e => e.ts >= cutoff);
    history.set(fingerprint, valid);
  }

  function toJSON() {
    const out = {};
    for (const [fp, arr] of history.entries()) {
      if (arr.length) out[fp] = arr;
    }
    return out;
  }

  function clear() {
    history.clear();
  }

  return { record, getHistory, getVelocity, predictMinutesToLimit, getAllFingerprints, load, toJSON, clear };
}

// ─────────────────────────────────────────────────
// OAuth Token Refresh  - Pure Functions
// ─────────────────────────────────────────────────

/**
 * Build JSON POST body for the OAuth token refresh endpoint.
 */
export function buildRefreshRequestBody(refreshToken, clientId, scope) {
  const body = { grant_type: 'refresh_token', refresh_token: refreshToken };
  if (clientId) body.client_id = clientId;
  if (scope) body.scope = scope;
  return JSON.stringify(body);
}

/**
 * Parse the OAuth refresh endpoint response.
 * Returns { ok, accessToken, refreshToken, expiresIn } on success,
 * or { ok: false, error, retriable } on failure.
 */
export function parseRefreshResponse(statusCode, bodyStr) {
  if (statusCode >= 200 && statusCode < 300) {
    try {
      const data = JSON.parse(bodyStr);
      const accessToken = data.access_token || data.accessToken;
      const refreshToken = data.refresh_token || data.refreshToken;
      const expiresIn = data.expires_in || data.expiresIn || 0;
      if (!accessToken) {
        return { ok: false, error: 'No access_token in response', retriable: false };
      }
      return { ok: true, accessToken, refreshToken: refreshToken || null, expiresIn };
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${e.message}`, retriable: false };
    }
  }
  // Retriable: 429 (rate limit), 500+ (server errors)
  const retriable = statusCode === 429 || statusCode >= 500;
  let error = `HTTP ${statusCode}`;
  try {
    const data = JSON.parse(bodyStr);
    const raw = data.error_description || data.error || data.message || error;
    error = typeof raw === 'string' ? raw : (raw && raw.message) || JSON.stringify(raw);
  } catch {}
  return { ok: false, error, retriable };
}

/**
 * Convert expires_in (seconds) to an absolute millisecond timestamp.
 */
export function computeExpiresAt(expiresInSec, now = Date.now()) {
  return now + expiresInSec * 1000;
}

/**
 * Immutably build updated credentials, preserving all fields except tokens/expiry.
 */
export function buildUpdatedCreds(oldCreds, newAccessToken, newRefreshToken, newExpiresAt) {
  return {
    ...oldCreds,
    claudeAiOauth: {
      ...oldCreds.claudeAiOauth,
      accessToken: newAccessToken,
      ...(newRefreshToken != null ? { refreshToken: newRefreshToken } : {}),
      expiresAt: newExpiresAt,
    },
  };
}

/**
 * Returns true if the token is within bufferMs of expiry.
 * Returns false for unknown/falsy expiresAt (don't proactively refresh unknown tokens).
 */
export function shouldRefreshToken(expiresAt, bufferMs = 60 * 60 * 1000, now = Date.now()) {
  if (!expiresAt) return false;
  return expiresAt - now <= bufferMs;
}

/**
 * Promise-chain mutex keyed by account name.
 * Ensures only one refresh runs per account at a time.
 */
export function createPerAccountLock() {
  const locks = new Map();

  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise(r => { release = r; });
    locks.set(key, next);
    return prev.then(fn).finally(release);
  }

  return { withLock };
}
