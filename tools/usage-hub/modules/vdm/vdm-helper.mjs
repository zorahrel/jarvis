#!/usr/bin/env node
// Van Damme-o-Matic — CLI helper
//
// The `vdm` shell script needs to read and write JSON, hash tokens, and touch
// the credential store. It used to do all of that by piping into `python3 -c`
// with the shell variables interpolated straight into the Python source. Two
// problems with that, one of which is not about Windows at all:
//
//   * python3 is not present on a default Windows install (the `python3` on
//     PATH is a Microsoft Store stub that prints an ad and exits non-zero),
//     while Node is already a hard requirement of this project.
//   * a profile path or config key containing a quote was injected into the
//     Python source, so it either crashed or ran as code. Here every value
//     arrives through argv and is never parsed as anything but data.
//
// Each subcommand prints one line on stdout and exits 0, or exits non-zero with
// a message on stderr. Nothing here ever prints a token.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readCredentials, writeCredentials, portInUse, IS_WINDOWS } from './platform.mjs';

const [, , cmd, ...args] = process.argv;

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    die(`cannot read JSON from ${path}: ${e.message}`);
  }
}

function fingerprint(token) {
  return createHash('sha256').update(token || '').digest('hex').slice(0, 16);
}

/**
 * The pid listening on a TCP port, or null.
 *
 * Only needed to kill a stray dashboard, so a miss is survivable: callers fall
 * back to the pid file. `netstat -ano` is used on Windows because it is present
 * on every install and its numeric columns are not translated, unlike the
 * headers, which is why the parse never looks at them.
 */
function pidOnPort(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    if (IS_WINDOWS) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        // proto local foreign state pid
        if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
        const localPort = parts[1].split(':').pop();
        if (Number(localPort) === port) return Number(parts[4]);
      }
      return null;
    }
    const out = execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const first = out.split('\n')[0];
    return first ? Number(first) : null;
  } catch {
    return null; // nothing listening, or the tool is unavailable
  }
}

/**
 * Parses settings.json, backing up and starting fresh if it is corrupt.
 * Overwriting a file we could not read would silently discard the user's
 * unrelated settings, so the broken copy is kept alongside.
 */
function loadSettingsOrBackup(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    try { writeFileSync(`${file}.vdm-backup`, raw); } catch { /* best effort */ }
    return {};
  }
}

/** Adds an HTTP hook for `event` unless one with the same URL already exists. */
function ensureHook(hooks, event, url) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  for (const entry of hooks[event]) {
    const inner = entry && typeof entry === 'object' ? entry.hooks || [] : [];
    if (inner.some(h => h && h.url === url)) return; // already installed
  }
  hooks[event].push({ hooks: [{ type: 'http', url, timeout: 5 }] });
}

/** Removes our hook from `event`, leaving anyone else's entries untouched. */
function removeHook(hooks, event, url) {
  if (!Array.isArray(hooks[event])) return;
  hooks[event] = hooks[event].filter((entry) => {
    const inner = entry && typeof entry === 'object' ? entry.hooks || [] : [];
    return !inner.some(h => h && h.url === url);
  });
  if (hooks[event].length === 0) delete hooks[event];
}

/** Thousands separators, optionally right-aligned to `width`. */
function num(n, width = 0) {
  const s = Number(n || 0).toLocaleString('en-US');
  return width ? s.padStart(width) : s;
}

/** Reads all of stdin, parses it as JSON, and hands it to `fn`. */
function withStdinJson(fn) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    fn(parsed);
  });
}

function oauthOf(creds) {
  return creds?.claudeAiOauth || {};
}

/** `subscriptionType|tier|expiry` — the pipe-joined shape `vdm` splits on. */
function profileInfo(creds) {
  const o = oauthOf(creds);
  const sub = o.subscriptionType || 'unknown';
  const tier = o.rateLimitTier || 'unknown';
  const tierShort = tier.includes('_') ? tier.split('_').pop() : tier;
  let exp = 'unknown';
  if (o.expiresAt) {
    const d = new Date(o.expiresAt);
    const p = (n) => String(n).padStart(2, '0');
    exp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return `${sub}|${tierShort}|${exp}`;
}

const commands = {
  // ── credential store ──

  // Prints the active credentials as one-line JSON. Exits 1 when there are none,
  // which is how the shell tells "logged out" from "broken".
  'read-creds'() {
    const creds = readCredentials();
    if (!creds) process.exit(1);
    process.stdout.write(JSON.stringify(creds));
  },

  // Writes the given profile file as the active credentials. Takes a path
  // rather than stdin so the blob never appears in a shell variable, a process
  // listing, or the shell's history.
  'write-creds'([file]) {
    if (!file) die('write-creds needs a profile path');
    const creds = readJsonFile(file);
    if (!oauthOf(creds).accessToken) die(`${file} has no claudeAiOauth.accessToken`);
    try {
      writeCredentials(creds);
    } catch (e) {
      die(`could not write credentials: ${e.message}`);
    }
  },

  // ── fingerprints ──

  'active-fingerprint'() {
    const creds = readCredentials();
    if (!creds) process.exit(1);
    process.stdout.write(fingerprint(oauthOf(creds).accessToken));
  },

  'profile-fingerprint'([file]) {
    if (!file || !existsSync(file)) process.exit(1);
    process.stdout.write(fingerprint(oauthOf(readJsonFile(file)).accessToken));
  },

  // ── profile display ──

  'profile-info'([file]) {
    if (!file || !existsSync(file)) process.exit(1);
    process.stdout.write(profileInfo(readJsonFile(file)));
  },

  // Like profile-info but with the granted scopes appended, which `vdm status`
  // shows and the per-profile listing does not.
  'active-info'() {
    const creds = readCredentials();
    if (!creds) process.exit(1);
    const o = oauthOf(creds);
    const tier = o.rateLimitTier || 'unknown';
    // status prints the full tier, unlike the list view's shortened form.
    const base = profileInfo(creds).split('|');
    process.stdout.write(`${base[0]}|${tier}|${base[2]}|${(o.scopes || []).join(', ')}`);
  },

  'active-token'() {
    const creds = readCredentials();
    const token = oauthOf(creds).accessToken;
    if (!token) process.exit(1);
    process.stdout.write(token);
  },

  // ── config.json ──

  'config-get'([file, key]) {
    if (!file || !key) die('config-get needs <file> <key>');
    if (!existsSync(file)) return; // absent config reads as empty, not an error
    const v = readJsonFile(file)[key];
    if (v === undefined || v === null) return;
    process.stdout.write(String(v));
  },

  // Writes a single key, preserving everything else and the file's formatting
  // conventions. `type` keeps the shell from having to know JSON types.
  'config-set'([file, key, value, type = 'string']) {
    if (!file || !key) die('config-set needs <file> <key> <value> [type]');
    const cfg = existsSync(file) ? readJsonFile(file) : {};
    if (type === 'bool') cfg[key] = value === 'true' || value === 'on' || value === '1';
    else if (type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) die(`${value} is not a number`);
      cfg[key] = n;
    } else if (type === 'null') cfg[key] = null;
    else cfg[key] = value;
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  },

  // Why the proxy will not pick an account, in one line, or nothing when it is
  // fine. `vdm list` used to print a rate-limited account exactly like a healthy
  // one, so the only way to learn that rotation was skipping it was to read
  // account-state.json by hand.
  'block-state'([file, fp, disabledMarker]) {
    if (!file || !fp) die('block-state needs <state-file> <fingerprint> [disabled-marker]');
    // Being switched off outranks any cooldown: the account is not coming back
    // when the timer runs out, so printing "torna domenica" for it is a lie.
    if (disabledMarker && existsSync(disabledMarker)) {
      process.stdout.write('escluso dalla rotazione (riattivabile dalla dashboard)');
      return;
    }
    if (!existsSync(file)) return;
    const st = readJsonFile(file)[fp];
    if (!st || !st.limited) return;
    const until = st.retryAfter && st.retryAfter > Date.now()
      ? new Date(st.retryAfter).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : null;
    // 'model' is also what every account-wide 429 used to be filed as: read the windows
    // first, as the dashboard does, so a full week is not called a single model's limit.
    const kind = (!st.blockKind || st.blockKind === 'model')
      ? ((st.utilization5h || 0) >= 0.9 ? 'quota-5h' : (st.utilization7d || 0) >= 0.9 ? 'quota-7d' : st.blockKind)
      : st.blockKind;
    const why = {
      'quota-5h': 'finestra 5h esaurita',
      'quota-7d': 'finestra settimanale esaurita',
      'extra-usage': 'extra usage esaurito',
      'permission': 'OAuth negato per l\'organizzazione',
      'auth': 'token scaduto',
      'model': 'rate limit sul singolo modello (429 con le finestre libere: di norma Opus)',
    }[kind] || 'bloccato dal proxy';
    process.stdout.write(`${why}${until ? ` — torna ${until}` : ''}`);
  },

  // The models an account is paused for, while it keeps serving the others
  // (LOCAL-PATCHES 2026-09-25). Nothing when it is paused for none.
  'model-blocks'([file, name]) {
    if (!file || !name) die('model-blocks needs <model-blocks-file> <account-name>');
    if (!existsSync(file)) return;
    const names = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
    const now = Date.now();
    const paused = Object.entries(readJsonFile(file)[name] || {})
      .filter(([, until]) => until > now)
      .sort((a, b) => a[1] - b[1])
      .map(([key, until]) => {
        const [family, oneM] = key.split('-');
        const when = new Date(until).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        return `${names[family] || family}${oneM ? ' (contesto 1M)' : ''} fino a ${when}`;
      });
    process.stdout.write(paused.join(', '));
  },

  // One key as a JSON object, for POSTing a single setting to the dashboard.
  'config-one'([file, key]) {
    if (!file || !key) die('config-one needs <file> <key>');
    const cfg = existsSync(file) ? readJsonFile(file) : {};
    process.stdout.write(JSON.stringify({ [key]: cfg[key] ?? null }));
  },

  // ── activity log ──

  // Prepends an entry and caps the file, matching what the dashboard expects.
  'log-activity'([file, type, ...pairs]) {
    if (!file || !type) die('log-activity needs <file> <type> [k=v ...]');
    const entry = { ts: Date.now(), type };
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i > 0) entry[p.slice(0, i)] = p.slice(i + 1);
    }
    let log = [];
    try { log = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first entry */ }
    if (!Array.isArray(log)) log = [];
    log.unshift(entry);
    writeFileSync(file, JSON.stringify(log.slice(0, 200), null, 2));
  },

  // ── misc ──

  'urlencode'([value = '']) {
    process.stdout.write(encodeURIComponent(value));
  },

  // Reads one field out of a JSON document on stdin. Used for small API replies.
  'json-get'([key]) {
    if (!key) die('json-get needs a key');
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { raw += c; });
    process.stdin.on('end', () => {
      try {
        const v = JSON.parse(raw)[key];
        if (v !== undefined && v !== null) process.stdout.write(String(v));
      } catch { /* unparseable input reads as empty */ }
    });
  },

  // Extracts the account email from the roles endpoint's organization_name,
  // which reads "user@example.com's Organization".
  'parse-org-email'() {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { raw += c; });
    process.stdin.on('end', () => {
      try {
        const name = JSON.parse(raw).organization_name || '';
        const m = name.match(/^(.+?)(?:'s Organization| Organization)$/);
        process.stdout.write(m ? m[1] : name);
      } catch { /* no email available */ }
    });
  },

  // ── Claude Code settings.json hooks ──

  // Adds the UserPromptSubmit/Stop HTTP hooks, preserving every other setting.
  // A corrupt settings.json is backed up rather than overwritten: it is the
  // user's file, and it may hold things this tool knows nothing about.
  'hooks-install'([file, port = '3333']) {
    if (!file) die('hooks-install needs <settings.json> <port>');
    const settings = loadSettingsOrBackup(file);
    settings.hooks ||= {};
    ensureHook(settings.hooks, 'UserPromptSubmit', `http://localhost:${port}/api/session-start`);
    ensureHook(settings.hooks, 'Stop', `http://localhost:${port}/api/session-stop`);
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  },

  'hooks-uninstall'([file, port = '3333']) {
    if (!file || !existsSync(file)) return;
    let settings;
    try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
    if (!settings || typeof settings !== 'object' || !settings.hooks) return;
    removeHook(settings.hooks, 'UserPromptSubmit', `http://localhost:${port}/api/session-start`);
    removeHook(settings.hooks, 'Stop', `http://localhost:${port}/api/session-stop`);
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  },

  // Decides whether the commit-msg hook should run at all.
  // Exits 0 when commitTokenUsage is on, 1 otherwise (including unreachable).
  'commit-tokens-enabled'() {
    withStdinJson((s) => {
      process.exit(s && s.commitTokenUsage ? 0 : 1);
    });
  },

  // Builds the `Token-Usage:` trailer and appends it to the commit message.
  // Usage JSON comes in on stdin, not argv: a large repo's usage can exceed the
  // command-line length limit, and on Windows that limit is far lower.
  'commit-trailer'([msgFile]) {
    withStdinJson((usage) => {
      if (!msgFile || !Array.isArray(usage) || usage.length === 0) return;
      const models = new Map();
      for (const e of usage) {
        const m = e.model || 'unknown';
        const cur = models.get(m) || { in: 0, out: 0 };
        cur.in += e.inputTokens || 0;
        cur.out += e.outputTokens || 0;
        models.set(m, cur);
      }
      const total = [...models.values()].reduce((a, v) => a + v.in + v.out, 0);
      if (total <= 0) return;

      // claude-sonnet-4-6-20250514 → sonnet 4.6
      const shortModel = (m) => {
        let x = String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');
        const match = x.match(/^([a-z]+(?:-[a-z]+)*)-(\d+(?:-\d+)*)$/);
        return match ? `${match[1]} ${match[2].replace(/-/g, '.')}` : x;
      };
      const lines = [...models.keys()].sort().map((model) => {
        const v = models.get(model);
        return `${shortModel(model)}: ${num(v.in)} / ${num(v.out)}`;
      });
      const trailer = `Token-Usage: ${lines.join(', ')}`;

      let content;
      try { content = readFileSync(msgFile, 'utf8'); } catch { return; }
      if (content.includes('Token-Usage:')) return; // never duplicate
      writeFileSync(msgFile, `${content.replace(/\s+$/, '')}\n\n${trailer}\n`);
    });
  },

  // ── ports ──

  // Prints the pid listening on a TCP port, or exits 1. `lsof` does not exist
  // on Windows, and netstat's output is localised; the OS-specific lookup lives
  // here so the shell can just ask the question.
  'port-pid'([port]) {
    const pid = pidOnPort(Number(port));
    if (!pid) process.exit(1);
    process.stdout.write(String(pid));
  },

  // Exit 0 if something is listening on the port, 1 otherwise. Answers the
  // reachability question directly instead of parsing any tool's output, so a
  // listener that lsof cannot see (another user, a container) still counts.
  'port-busy'([port]) {
    portInUse(Number(port)).then(busy => process.exit(busy ? 0 : 1));
  },

  // ── token usage reports ──

  // The usage array arrives on stdin. It used to be interpolated into Python
  // source inside triple quotes, so a repo name containing a quote ended the
  // literal and the report died with a syntax error.
  'usage-summary'() {
    withStdinJson((usage) => {
      if (!Array.isArray(usage) || usage.length === 0) {
        console.log('  No token usage recorded in this period.');
        return;
      }
      const models = new Map();
      let totalIn = 0, totalOut = 0;
      for (const e of usage) {
        const m = e.model || 'unknown';
        const cur = models.get(m) || { input: 0, output: 0 };
        cur.input += e.inputTokens || 0;
        cur.output += e.outputTokens || 0;
        models.set(m, cur);
        totalIn += e.inputTokens || 0;
        totalOut += e.outputTokens || 0;
      }
      for (const [model, c] of [...models].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`  ${model}`);
        console.log(`    Input:  ${num(c.input, 10)} tokens`);
        console.log(`    Output: ${num(c.output, 10)} tokens`);
        console.log(`    Total:  ${num(c.input + c.output, 10)} tokens`);
        console.log('');
      }
      console.log(`  Grand Total: ${num(totalIn + totalOut)} tokens (${num(totalIn)} in / ${num(totalOut)} out)`);
      console.log(`  Entries: ${usage.length}`);
    });
  },

  // Buckets usage between consecutive commits of `repo`.
  'usage-per-commit'([repo]) {
    withStdinJson((usage) => {
      if (!repo) { console.log('  No repo specified or detected.'); return; }
      let log;
      try {
        log = execFileSync('git', ['-C', repo, 'log', '--format=%H %ct %s', '--reverse'],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();
      } catch {
        console.log('  Could not read git log.');
        return;
      }
      const commits = [];
      for (const line of log.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split(' ');
        if (parts.length < 3) continue;
        commits.push({
          hash: parts[0].slice(0, 7),
          ts: Number(parts[1]) * 1000,
          msg: parts.slice(2).join(' '),
        });
      }
      if (commits.length === 0) { console.log('  No commits found.'); return; }

      const rows = Array.isArray(usage) ? usage : [];
      const buckets = [];
      for (let i = 0; i < commits.length; i++) {
        const start = commits[i].ts;
        const end = i + 1 < commits.length ? commits[i + 1].ts : Infinity;
        const tokens = rows
          .filter(e => e.ts >= start && e.ts < end)
          .reduce((a, e) => a + (e.inputTokens || 0) + (e.outputTokens || 0), 0);
        if (tokens > 0) buckets.push({ hash: commits[i].hash, tokens, msg: commits[i].msg.slice(0, 60) });
      }
      const lastTs = commits[commits.length - 1].ts;
      const uncommitted = rows
        .filter(e => e.ts >= lastTs)
        .reduce((a, e) => a + (e.inputTokens || 0) + (e.outputTokens || 0), 0);

      if (buckets.length === 0 && uncommitted <= 0) {
        console.log('  No token usage found in this period.');
        return;
      }
      for (const b of buckets) console.log(`  ${b.hash}  ${num(b.tokens, 10)} tok  ${b.msg}`);
      if (uncommitted > 0) console.log(`  (uncommitted)  ${num(uncommitted, 10)} tok`);
      const total = buckets.reduce((a, b) => a + b.tokens, 0) + Math.max(uncommitted, 0);
      console.log('');
      console.log(`  Total: ${num(total)} tokens`);
    });
  },

  // Colourises one SSE log line for `vdm logs`.
  'format-log-line'() {
    withStdinJson((d) => {
      const colors = {
        error: '\x1b[0;31m', warn: '\x1b[1;33m', switch: '\x1b[0;36m',
        refresh: '\x1b[0;34m', proactive: '\x1b[0;35m', info: '\x1b[0m',
        system: '\x1b[0;32m',
      };
      const color = colors[d.tag] ?? '\x1b[2m';
      console.log(`${color}${d.line ?? d.msg ?? ''}\x1b[0m`);
    });
  },

  // Formats the balance block of /api/proxy-status for `vdm status`.
  'format-balance'() {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { raw += c; });
    process.stdin.on('end', () => {
      let b;
      try { b = JSON.parse(raw).balance; } catch { return; }
      if (!b) return;
      const total = b.totalInflight || 0;
      const waiting = b.waiting || 0;
      let out = `  In-flight:     ${total} total${waiting ? `, ${waiting} waiting for a slot` : ''}\n`;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
      const rows = (parsed.accounts || [])
        .filter(a => a.inflight)
        .map(a => [a.label || a.name, a.inflight])
        .sort((x, y) => y[1] - x[1]);
      for (const [name, n] of rows) out += `                 ${name}: ${n}\n`;
      process.stdout.write(out);
    });
  },
};

const handler = commands[cmd];
if (!handler) die(`unknown helper command: ${cmd || '(none)'}`);
handler(args);
