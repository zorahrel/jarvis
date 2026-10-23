import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { recordApiSpend } from './api-spend.mjs';

export const API_ACCOUNTS_FILE = process.env.VDM_API_ACCOUNTS_FILE || (process.env.VDM_STATE_DIR ? `${process.env.VDM_STATE_DIR}/api-accounts.json` : new URL('./api-accounts.json', import.meta.url).pathname);

export function readApiAccounts(file = API_ACCOUNTS_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(account => account && /^[a-zA-Z0-9_-]{1,48}$/.test(account.name || '') &&
      typeof account.service === 'string' && typeof account.account === 'string' &&
      Number.isFinite(Number(account.priority)) && Number.isInteger(Number(account.priority)));
  } catch { return []; }
}

export function writeApiAccounts(accounts, file = API_ACCOUNTS_FILE) {
  writeFileSync(file, JSON.stringify(accounts.map(({ name, label, service, account, workspaceId, priority, disabled }) => ({
    name, label: String(label || name).slice(0, 80), service, account,
    ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
    priority: Number(priority) || 0, disabled: !!disabled,
  })), null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

export function getApiKey(account) {
  if (process.platform !== 'darwin') throw new Error('Anthropic API account secrets require macOS Keychain');
  return execFileSync('/usr/bin/security', ['find-generic-password', '-s', account.service, '-a', account.account, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
  }).trim();
}

export function safeApiProfiles(file = API_ACCOUNTS_FILE) {
  return readApiAccounts(file).map(({ name, label, workspaceId, priority, disabled }) => ({
    type: 'api', name, label: label || name, workspaceId: workspaceId || null,
    priority: Number(priority) || 0, disabled: !!disabled,
    usage5h: null, usage7d: null, balance: null,
  }));
}

export function buildApiHeaders(original, account, key, bodyLength) {
  const headers = { ...original };
  for (const keyName of ['authorization', 'x-api-key', 'anthropic-workspace-id', 'host', 'content-length']) delete headers[keyName];
  headers['x-api-key'] = key;
  const beta = String(headers['anthropic-beta'] || '').split(',').map(x => x.trim())
    .filter(x => x && !x.startsWith('oauth-'));
  if (beta.length) headers['anthropic-beta'] = beta.join(',');
  else delete headers['anthropic-beta'];
  if (account.workspaceId) headers['anthropic-workspace-id'] = account.workspaceId;
  headers['content-length'] = String(bodyLength);
  return headers;
}

export function isOAuthPotentiallySelectable(account, { isAvailable, isCapped, isModelBlocked, state = {}, refreshAttempted = false, now = Date.now() } = {}) {
  if (!account || account.disabled || isCapped?.(account) || isModelBlocked?.(account)) return false;
  if (isAvailable?.(account)) return true;
  const activeQuotaBlock = state.limited && (
    (state.retryAfter && state.retryAfter >= now) ||
    (state.resetAt && state.resetAt >= now / 1000) ||
    (state.resetAt7d && state.resetAt7d >= now / 1000)
  );
  const expired = (account.expiresAt && account.expiresAt < now) || state.expired;
  return !!expired && !refreshAttempted && !!account.creds?.claudeAiOauth?.refreshToken && !activeQuotaBlock;
}

function consumeStream(stream) {
  return new Promise(resolve => {
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
      (async () => {
        const chunks = [];
        try {
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        } catch { /* La risposta parziale resta utile per classificare l'errore. */ }
        resolve(Buffer.concat(chunks));
      })();
      return;
    }
    if (stream && typeof stream.getReader === 'function') {
      (async () => {
        const chunks = [];
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
          }
        } catch { /* La risposta parziale resta utile per classificare l'errore. */ }
        resolve(Buffer.concat(chunks));
      })();
      return;
    }
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function requestModel(body) {
  try {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    const model = JSON.parse(text).model;
    return typeof model === 'string' && model.trim() ? model.trim().slice(0, 128) : null;
  } catch { return null; }
}

function readUsage(value, totals) {
  if (!value || typeof value !== 'object') return;
  const candidates = [value.usage, value.message?.usage, value.delta?.usage, value.message_delta?.usage];
  for (const usage of candidates) {
    if (!usage || typeof usage !== 'object') continue;
    const fields = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheWrite: usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
    };
    for (const [field, count] of Object.entries(fields)) {
      const number = Number(count);
      if (Number.isFinite(number) && number >= 0) totals[field] = Math.max(totals[field], Math.floor(number));
    }
  }
}

function safeRecordApiSpend(keyName, model, usage) {
  try { recordApiSpend({ keyName, model, usage }); } catch { /* Il tracciamento non deve interrompere il proxy. */ }
}

function recordResponseUsage(stream, keyName, model) {
  void (async () => {
    try {
      const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let dataLines = [];
      const consumeEvent = () => {
        if (!dataLines.length) return;
        try { readUsage(JSON.parse(dataLines.join('\n')), totals); } catch {}
        dataLines = [];
      };
      const parseLines = (chunk, final = false) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = final ? '' : lines.pop();
        if (final && lines.length && lines.at(-1) === '') lines.pop();
        for (const line of lines) {
          if (!line) consumeEvent();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (final) consumeEvent();
      };
      while (true) {
        const { done, value } = await reader.read();
        parseLines(decoder.decode(value || new Uint8Array(), { stream: !done }), done);
        if (done) break;
      }
      if (Object.values(totals).some(Boolean)) safeRecordApiSpend(keyName, model, totals);
    } catch { /* Lo stream di misura è best-effort; il ramo client è indipendente. */ }
  })();
}

function recordBodyUsage(body, keyName, model) {
  try {
    const usage = JSON.parse(Buffer.from(body || '').toString('utf8')).usage;
    const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    readUsage({ usage }, totals);
    if (Object.values(totals).some(Boolean)) queueMicrotask(() => safeRecordApiSpend(keyName, model, totals));
  } catch { /* Le risposte non JSON non hanno usage da registrare. */ }
}

export async function routeApiFallback({ method, path, headers, body, send, accounts = readApiAccounts(), secret = getApiKey, request, oauthSelectable = false, oauthAccounts, isOAuthSelectable }) {
  if (oauthSelectable || (oauthAccounts && oauthAccounts.some(isOAuthSelectable || (() => true)))) return false;
  if (method !== 'POST') return false;
  if (!/^\/v1\/(?:messages|messages\/count_tokens)(?:\?|$)/.test(path || '')) return false;
  const candidates = accounts.filter(a => !a.disabled).sort((a, b) => Number(b.priority) - Number(a.priority));
  if (!candidates.length) return false;
  const failures = [];
  for (const account of candidates) {
    let key;
    try { key = secret(account); }
    catch { failures.push({ account, status: 401, body: Buffer.from('Keychain credential unavailable') }); continue; }
    const forwarded = buildApiHeaders(headers, account, key, body.length);
    const response = await request(method, path, forwarded, body);
    const responseBody = response.body !== undefined
      ? (Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || ''))
      : (response.status >= 400 && response.stream ? await consumeStream(response.stream) : Buffer.alloc(0));
    const text = responseBody.toString('utf8');
    const eligibilityError = [401, 402, 403].includes(response.status) ||
      (response.status === 400 && /billing|payment|authentication|invalid.?api.?key|workspace|organization|permission|credit|spend.?limit|rate.?limit/i.test(text));
    if (eligibilityError) { failures.push({ account, key, status: response.status, body: responseBody }); continue; }
    const spendModel = /^\/v1\/messages(?:\?|$)/.test(path || '') && response.status >= 200 && response.status < 300
      ? requestModel(body) : null;
    let outgoing = response.status >= 400 ? responseBody : (response.stream || responseBody);
    let meterStream = null;
    if (spendModel && response.stream && typeof response.stream.tee === 'function') {
      try { [outgoing, meterStream] = response.stream.tee(); } catch { /* Continua con lo stream originale. */ }
    }
    send(response.status, response.headers || {}, outgoing);
    if (spendModel && response.body !== undefined) recordBodyUsage(responseBody, account.name, spendModel);
    else if (spendModel && meterStream) recordResponseUsage(meterStream, account.name, spendModel);
    return true;
  }
  const last = failures.at(-1);
  if (last) {
    const safeBody = last.key ? Buffer.from(last.body.toString('utf8').split(last.key).join('[redacted]')) : last.body;
    send(last.status, { 'content-type': 'application/json' }, safeBody);
  }
  return !!last;
}
