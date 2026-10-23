// Van Damme-o-Matic — platform layer
//
// Everything that differs between macOS and Windows lives here, so the rest of
// the codebase can stay platform-blind. Two facts drive the whole file:
//
//   * macOS Claude Code keeps its OAuth credentials in the login Keychain, under
//     a generic password whose service name it occasionally renames.
//   * Windows Claude Code keeps them in a plain file, `%USERPROFILE%\.claude\
//     .credentials.json`, guarded by a sibling `.credentials.json.lock` holding
//     `{"pid":…,"at":…}`.
//
// The two stores are not just different APIs: the file store has no atomicity of
// its own, so a naive write can be read half-finished by a live Claude Code
// session and kill it. Hence the lock protocol and the rename-based write below.

import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';

// `process.env.HOME` is empty on Windows; `USERPROFILE` is empty on Unix.
// os.homedir() already resolves both, and falls back to the passwd entry.
export const HOME = homedir();

export function currentUser() {
  // `whoami` costs a process spawn and does not exist as such on Windows.
  return process.env.USER || process.env.USERNAME || userInfo().username;
}

export const CLAUDE_DIR = join(HOME, '.claude');
export const CREDENTIALS_FILE = join(CLAUDE_DIR, '.credentials.json');
const CREDENTIALS_LOCK = `${CREDENTIALS_FILE}.lock`;

// ─────────────────────────────────────────────────
// macOS: Keychain
// ─────────────────────────────────────────────────

const KEYCHAIN_CMD_TIMEOUT = 5000;
const KEYCHAIN_ACCOUNT = currentUser();

// Blocking pause with no process spawn — the credential readers are synchronous,
// so there is nothing to await, and spawning `sleep` would reintroduce the very
// cost the execFileSync switch removed.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Never let a credential blob reach the log. Node puts the whole argv in the
// error message of a failed execFileSync, which for add-generic-password means
// the access and refresh tokens in plaintext.
export function safeCredentialError(e) {
  const msg = String(e?.message || e);
  const code = e?.code ? ` (${e.code})` : '';
  return msg.includes('-w') ? `security add-generic-password failed${code}` : msg.split('\n')[0];
}

function detectKeychainService() {
  try {
    execFileSync('security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_CMD_TIMEOUT });
    return 'Claude Code-credentials';
  } catch { /* fall through to the broad search */ }
  try {
    const dump = execFileSync('security', ['dump-keychain'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_CMD_TIMEOUT });
    for (const line of dump.split('\n')) {
      const m = line.match(/"svce"<blob>="([^"]*claude[^"]*)"/i);
      if (m) return m[1];
    }
  } catch { /* fall through to the default */ }
  return 'Claude Code-credentials';
}

// Resolved lazily: on Windows this must never spawn `security`, and even on
// macOS the dump-keychain fallback is slow enough to matter at import time.
let _keychainService = null;
export function keychainService() {
  if (!IS_MACOS) return null;
  if (_keychainService === null) _keychainService = detectKeychainService();
  return _keychainService;
}

// `-a` matters: the Keychain keys an item by service AND account, and a lookup
// by service alone returns whichever item it meets first. On 2026-09-11 Claude
// Code (a Bun binary, where os.userInfo() answers "unknown" when USER is unset)
// ran under `env -i` and wrote a blank item under account "unknown". The
// service-only read returned it for 35 hours: activeToken "missing", no
// keychain updates on refresh, and every reader downstream stuck on a dead
// token, while the item this file writes (account = currentUser()) was live.
function findKeychainItem(account) {
  const args = ['find-generic-password', '-s', keychainService()];
  if (account) args.push('-a', account);
  args.push('-w');
  return execFileSync('security', args,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_CMD_TIMEOUT }
  ).trim();
}

const KEYCHAIN_ITEM_NOT_FOUND = 44;

function readKeychain() {
  // One retry: a read can lose a race against an external writer (Claude Code's
  // own login rewrites the item), and a second attempt ~50ms later costs nothing.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let raw;
      try {
        raw = findKeychainItem(KEYCHAIN_ACCOUNT);
      } catch (e) {
        // No item under our account (a login written by another tool): any account.
        if (e?.status !== KEYCHAIN_ITEM_NOT_FOUND) throw e;
        raw = findKeychainItem(null);
      }
      return JSON.parse(raw);
    } catch (e) {
      if (attempt === 0) { sleepSync(50); continue; }
      throw new Error(`Keychain read failed: ${safeCredentialError(e)}`);
    }
  }
  return null;
}

function writeKeychain(creds) {
  // `security` renders a generic password containing newlines as hexadecimal on
  // read, so the value must be one line. -U updates in place: the old
  // delete-then-add left the item missing for ~20-50ms and every concurrent read
  // in that window failed (measured 16 failures per 40 writes, 0 with -U).
  const json = JSON.stringify(creds);
  try {
    execFileSync('security',
      ['add-generic-password', '-U', '-s', keychainService(), '-a', KEYCHAIN_ACCOUNT, '-w', json],
      { stdio: 'pipe', timeout: KEYCHAIN_CMD_TIMEOUT });
    return;
  } catch { /* -U refused; fall back so the pointer can never become unwritable */ }
  try {
    execFileSync('security',
      ['delete-generic-password', '-s', keychainService(), '-a', KEYCHAIN_ACCOUNT],
      { stdio: 'pipe', timeout: KEYCHAIN_CMD_TIMEOUT });
  } catch { /* might not exist */ }
  try {
    execFileSync('security',
      ['add-generic-password', '-s', keychainService(), '-a', KEYCHAIN_ACCOUNT, '-w', json],
      { stdio: 'pipe', timeout: KEYCHAIN_CMD_TIMEOUT });
  } catch (e) {
    throw new Error(safeCredentialError(e)); // callers log this — keep the blob out
  }
}

// ─────────────────────────────────────────────────
// Windows: ~/.claude/.credentials.json + advisory lock
// ─────────────────────────────────────────────────

// Claude Code writes `{"pid":…,"at":…}` and expects the holder to clear it. A
// crashed holder would otherwise wedge the file forever, so a lock whose pid is
// gone — or which is older than this timeout — is broken deliberately rather
// than waited on.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 3_000;
const LOCK_POLL_MS = 50;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything. It works on Windows too: libuv maps it to OpenProcess.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return e.code === 'EPERM';
  }
}

function lockIsStale() {
  let raw;
  try { raw = readFileSync(CREDENTIALS_LOCK, 'utf8'); } catch { return true; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return true; } // garbage: never valid
  if (parsed?.pid === process.pid) return true;            // ours from a past run
  if (!processAlive(parsed?.pid)) return true;
  return Date.now() - (parsed?.at || 0) > LOCK_STALE_MS;
}

function acquireCredentialsLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      // wx fails if the file exists — the atomic test-and-set this needs.
      writeFileSync(CREDENTIALS_LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }),
        { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale()) {
        try { unlinkSync(CREDENTIALS_LOCK); } catch { /* someone else won the race */ }
        continue;
      }
      if (Date.now() >= deadline) {
        // Proceeding without the lock beats refusing to switch accounts: the
        // write itself is atomic (rename), so the worst case is a lost update,
        // not a truncated credentials file.
        return false;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseCredentialsLock() {
  try { unlinkSync(CREDENTIALS_LOCK); } catch { /* already gone */ }
}

function readCredentialsFile() {
  const raw = readFileSync(CREDENTIALS_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeCredentialsFile(creds) {
  const json = JSON.stringify(creds);
  const dir = dirname(CREDENTIALS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const held = acquireCredentialsLock();
  // Same-directory temp + rename: on both platforms this is atomic, so a
  // concurrent reader sees either the old file or the new one, never a partial
  // write. A live Claude Code session reads this file on every request.
  const tmp = `${CREDENTIALS_FILE}.vdm-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, json, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows ACLs ignore mode */ }
    renameSync(tmp, CREDENTIALS_FILE);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed away, as expected */ }
    if (held) releaseCredentialsLock();
  }
}

// ─────────────────────────────────────────────────
// Public credential API
// ─────────────────────────────────────────────────

export const CREDENTIAL_STORE = IS_WINDOWS ? 'file' : 'keychain';

/** Human-readable location, for diagnostics and error messages. */
export function credentialStoreLabel() {
  return IS_WINDOWS ? CREDENTIALS_FILE : `macOS Keychain (${keychainService()})`;
}

/** Returns the parsed credentials object, or null if unreadable. */
export function readCredentials() {
  try {
    return IS_WINDOWS ? readCredentialsFile() : readKeychain();
  } catch {
    return null;
  }
}

/** Same as readCredentials but throws with a redacted message. Callers log it. */
export function readCredentialsOrThrow() {
  return IS_WINDOWS ? readCredentialsFile() : readKeychain();
}

/** Writes the active credentials. Throws (redacted) on failure. */
export function writeCredentials(creds) {
  if (IS_WINDOWS) writeCredentialsFile(creds);
  else writeKeychain(creds);
}

// ─────────────────────────────────────────────────
// Desktop notifications
// ─────────────────────────────────────────────────


/**
 * Fire-and-forget desktop notification. Never throws, never blocks.
 *
 * Windows has no `osascript`; the closest no-install equivalent is a PowerShell
 * toast. Both are best-effort — a missing notification must not affect routing.
 */
// Comando della notifica, senza eseguirlo: cosi' l'escaping si prova nei test
// senza far comparire notifiche vere sul Mac di chi lancia la suite.
export function buildNotifyCommand(title, message, platform = process.platform) {
  if (platform === 'darwin') {
    // AppleScript: prima i backslash, poi le virgolette (un "\\" finale chiuderebbe la stringa).
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ['osascript', ['-e',
      `display notification "${esc(message)}" with title "${esc(title)}" sound name "Blow"`,
    ], { timeout: 3000 }];
  }
  if (platform === 'win32') {
    // Single-quoted PowerShell strings only need '' doubling, which avoids the
    // backslash-escaping minefield of passing quotes through cmd.exe.
    const esc = (s) => String(s).replace(/'/g, "''");
    return ['powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;` +
      `$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(` +
      `[Windows.UI.Notifications.ToastTemplateType]::ToastText02);` +
      `$n=$t.GetElementsByTagName('text');` +
      `$n.Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) > $null;` +
      `$n.Item(1).AppendChild($t.CreateTextNode('${esc(message)}')) > $null;` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Van Damme-o-Matic').Show(` +
      `[Windows.UI.Notifications.ToastNotification]::new($t))`,
    ], { timeout: 5000, windowsHide: true }];
  }
  return null;
}

export async function notifyDesktop(title, message) {
  try {
    const cmd = buildNotifyCommand(title, message);
    if (!cmd) return;
    const { execFile } = await import('node:child_process');
    execFile(cmd[0], cmd[1], cmd[2], () => {});
  } catch { /* non-critical by definition */ }
}

// ─────────────────────────────────────────────────
// Misc platform differences
// ─────────────────────────────────────────────────

/**
 * Is something listening on this TCP port?
 *
 * `lsof` does not exist on Windows and `netstat` output is localised. A plain
 * connect attempt answers the actual question — "can a client reach it?" —
 * without parsing anyone's output.
 */
export async function portInUse(port, host = '127.0.0.1', timeoutMs = 500) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Git hook filename: Windows resolves hooks by name, without the +x bit. */
export function makeExecutable(file) {
  if (IS_WINDOWS) return; // NTFS has no executable bit; Git runs hooks via sh
  try { chmodSync(file, 0o755); } catch { /* best effort */ }
}
