#!/usr/bin/env node
// Riprende le sessioni Muse ferme per quota esaurita (Mac e PC via ssh).
// Rilevazione: ultimo turno `terminal:failed` con 429/rate limit e sessione ferma da >20 min.
// Meccanismo: 1) `muse session-message send --target <uuid>` (dentro la sessione viva, Mac con
// ingress aperto; su Windows e' "unsupported"). 2) Fallback dichiarato: si chiude in ordine il
// processo interattivo che possiede la sessione (avviato entro 5 s dall'istante UUIDv7 dell'id) e
// si riprende con `muse exec --session-id <uuid>` sullo stesso id, mai due processi sullo stesso id.
// Modello sempre muse-wonder-1.0 (mai full). Una ripresa per sessione per finestra di quota.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickMuseQuota } from '../src/quota.mjs';
import { fileURLToPath } from 'node:url';

export const RESUME_MESSAGE = 'La quota è tornata: continua da dove eri rimasto.';
export const MODEL = 'muse-wonder-1.0';
export const MIN_IDLE_MS = 20 * 60 * 1000;
export const MAX_AGE_MS = 24 * 3600 * 1000;
export const PC_HOST = 'zorah@192.168.1.2';
export const TAIL_BYTES = 600 * 1024;
const QUOTA_RE = /429|rate.?limit|quota.{0,30}(exhausted|exceeded)|subscription quota/i;

export function defaultSessionsRoot() {
  return path.join(os.homedir(), '.local', 'share', 'muse', 'sessions');
}

export function resumeLogFile() {
  return process.env.MUSE_RESUME_LOG || path.join(os.homedir(), '.openclaw', 'logs', 'muse-resume.log');
}

export function resumeStateFile() {
  return process.env.MUSE_RESUME_STATE || path.join(os.homedir(), '.cache', 'claude-usage-hub', 'muse-resume.json');
}

// Ultimo esito di turno nella coda del file: [terminal, reason].
function lastTerminal(tail) {
  let last = null;
  let reason = '';
  for (const m of tail.matchAll(/"kind":"terminal","terminal":"(\w+)"(?:,"reason":"((?:[^"\\]|\\.){0,300})")?/g)) {
    last = m[1];
    reason = (m[2] || '').replace(/\\"/g, '"');
  }
  return [last, reason];
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Sessioni ferme per quota: ultimo turno failed con 429/rate-limit nei log.
// Scansiona la struttura YYYY/MM/DD/<uuid>/session.jsonl.
export function findStalled(root = defaultSessionsRoot()) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const y of fs.readdirSync(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    const yDir = path.join(root, y);
    for (const m of safeDirs(yDir)) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of safeDirs(path.join(yDir, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        for (const s of safeDirs(path.join(yDir, m, d))) {
          const file = path.join(yDir, m, d, s, 'session.jsonl');
          let stat;
          try {
            stat = fs.statSync(file);
          } catch {
            continue;
          }
          let tail;
          try {
            tail = readTail(file);
          } catch {
            continue;
          }
          const [terminal, reason] = lastTerminal(tail);
          if (terminal !== 'failed' || !QUOTA_RE.test(reason)) continue;
          out.push({ id: s, file, mtimeMs: stat.mtimeMs, reason: reason.slice(0, 200), workspace: readWorkspace(file) });
        }
      }
    }
  }
  return out;
}

// Workspace registrato nei metadati di sessione (primi 256 KB).
function readWorkspace(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"workspace_root":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
      return m ? JSON.parse(`"${m[1]}"`) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function safeDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// Quota libera: 5h sotto il 95% e 7d sotto il 100%. Senza quota letta: ferma.
export async function quotaFree(trayUrl = 'http://127.0.0.1:3360/api/overview', fetchImpl = fetch) {
  try {
    const res = await fetchImpl(trayUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { free: false, quota: null };
    const quota = pickMuseQuota(await res.json());
    if (!quota) return { free: false, quota: null };
    const free = (quota.fiveHourPct ?? 0) < 95 && (quota.weekPct ?? 100) < 100;
    return { free, quota };
  } catch {
    return { free: false, quota: null };
  }
}

export function loadResumeState(file = resumeStateFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveResumeState(state, file = resumeStateFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

// Config opzionale fuori dal repo: { workspaces: { <sid>: <dir di lavoro> }, watchTargets: { <sid>: <dir watcher sul PC> } }.
function loadResumeConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'claude-usage-hub', 'muse-resume.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Istante UUIDv7 dell'id di sessione: il processo che l'ha creata parte entro pochi secondi.
export function uuidV7Ms(id) {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

// Mac, meccanismo 1: scrive dentro la sessione viva.
function macSendInside(id, message) {
  const r = spawnSync('muse', ['session-message', 'send', '--target', id], { input: message, encoding: 'utf8', timeout: 60000 });
  return !r.error && r.status === 0;
}

// Pid dei processi Muse interattivi (non exec) avviati entro 5 s dall'istante UUIDv7 della sessione.
export function macOwners(id) {
  const ps = spawnSync('ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8' }).stdout || '';
  const born = uuidV7Ms(id);
  const pids = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/.exec(line);
    if (!m || !/muse-bin/.test(m[3]) || / exec /.test(m[3])) continue;
    if (Math.abs(Date.parse(m[2]) - born) < 5000) pids.push(Number(m[1]));
  }
  return pids;
}

// Mac, fallback: chiude il processo interattivo proprietario e riprende headless sullo stesso id.
function macExecResume(s, message, cfg) {
  for (const pid of macOwners(s.id)) process.kill(pid, 'SIGTERM');
  const ws = cfg.workspaces?.[s.id] || s.workspace || os.homedir();
  const logDir = path.join(os.homedir(), '.openclaw', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `muse-resume-${s.id}.out`), 'a');
  const promptFile = path.join(os.tmpdir(), `muse-resume-${s.id}.txt`);
  fs.writeFileSync(promptFile, message);
  const child = spawnChild('muse', ['exec', '--model', MODEL, '--yolo', '--user-input-auto-resolve', '--workspace', ws,
    '--allow-workspace-switch', '--session-id', s.id, '--prompt-file', promptFile], out);
  return `exec pid ${child.pid}`;
}

function spawnChild(cmd, args, out) {
  const c = spawnSync('/bin/sh', ['-c', 'nohup "$@" </dev/null >&3 2>&1 & echo $!', 'sh', cmd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit', out] });
  return { pid: Number((c.stdout || '').trim()) || null };
}

function defaultMacResume(s, message) {
  if (macSendInside(s.id, message)) return 'session-message';
  return macExecResume(s, message, loadResumeConfig());
}

// PC: stesso schema via ssh + PowerShell (script in base64, lanciato con -File: lo stdin multiriga non e' affidabile).
export function runPowerShell(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const remote = `powershell -NoProfile -Command "[IO.File]::WriteAllBytes('C:\\Users\\zorah\\jarvis-watch\\_run.ps1',[Convert]::FromBase64String('${b64}')); & powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\zorah\\jarvis-watch\\_run.ps1"`;
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', PC_HOST, remote], { encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) throw new Error(`pc ssh failed: ${r.error?.message || (r.stderr || '').slice(0, 200)}`);
  return r.stdout || '';
}

const PC_DETECT = String.raw`
$root = Join-Path $env:USERPROFILE '.local\share\muse\sessions'
$cut = (Get-Date).AddDays(-2)
Get-ChildItem $root -Recurse -Filter session.jsonl | Where-Object { $_.LastWriteTime -gt $cut -and $_.FullName -notmatch '\\subagent\\' } | ForEach-Object {
  $fs = [IO.File]::Open($_.FullName, 'Open', 'Read', 'ReadWrite'); $n = [Math]::Min(600KB, $fs.Length)
  $fs.Seek(-$n, 'End') | Out-Null; $buf = New-Object byte[] $n; $r = $fs.Read($buf, 0, $n)
  $fs.Seek(0, 'Begin') | Out-Null; $hb = New-Object byte[] ([Math]::Min(256KB, $fs.Length)); $hr = $fs.Read($hb, 0, $hb.Length); $fs.Close()
  $tail = [Text.Encoding]::UTF8.GetString($buf, 0, $r); $head = [Text.Encoding]::UTF8.GetString($hb, 0, $hr)
  $last = ''; $reason = ''
  foreach ($m in [regex]::Matches($tail, '"kind":"terminal","terminal":"(\w+)"(?:,"reason":"([^"]{0,300})")?')) { $last = $m.Groups[1].Value; $reason = $m.Groups[2].Value }
  $ws = [regex]::Match($head, '"workspace_root":"((?:[^"\\]|\\.)*)"').Groups[1].Value -replace '\\\\', '\'
  $sid = $_.Directory.Name
  $born = [DateTimeOffset]::FromUnixTimeMilliseconds([Convert]::ToInt64($sid.Replace('-', '').Substring(0, 12), 16)).LocalDateTime
  $alive = [bool](Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'muse-bin*' -and $_.CommandLine -notmatch ' exec ' -and [Math]::Abs(($_.CreationDate - $born).TotalSeconds) -lt 5 })
  if ($last -eq 'failed') { @{ alive = $alive; id = $sid; mtimeMs = ([DateTimeOffset]$_.LastWriteTime).ToUnixTimeMilliseconds(); reason = $reason; workspace = $ws } | ConvertTo-Json -Compress }
}`;

export function findStalledPc(runPs = runPowerShell) {
  return runPs(PC_DETECT).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    .filter((s) => QUOTA_RE.test(s.reason));
}

export function pcResumeScript(s, message, cfg) {
  const ws = cfg.workspaces?.[s.id] || s.workspace || 'C:\\Users\\zorah';
  const watchDir = cfg.watchTargets?.[s.id] || '';
  const msg = Buffer.from(message, 'utf8').toString('base64');
  return String.raw`
$sid = '${s.id}'; $ws = '${ws}'; $watch = '${watchDir}'
$base = 'C:\Users\zorah\jarvis-watch'
$born = [DateTimeOffset]::FromUnixTimeMilliseconds(${uuidV7Ms(s.id)}).LocalDateTime
# Chiude in ordine il processo interattivo proprietario (avviato entro 5 s dall'id), mai gli exec.
Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'muse-bin*' -and $_.CommandLine -notmatch ' exec ' } | ForEach-Object {
  if ([Math]::Abs(($_.CreationDate - $born).TotalSeconds) -lt 5) { Stop-Process -Id $_.ProcessId -Force }
}
Start-Sleep 3
[IO.File]::WriteAllBytes("$base\resume-$sid.txt", [Convert]::FromBase64String('${msg}'))
Set-Content "$base\empty.txt" ''
$muse = (Get-ChildItem 'C:\Users\zorah\.local\bin\muse-bin-*.exe' | Sort-Object Name | Select-Object -Last 1).FullName
# Win32_Process.Create: il processo non e' figlio della sessione ssh e sopravvive alla sua chiusura
# (con Start-Process muore insieme a ssh, verificato 13/10).
$cmd = '"' + $muse + '" exec --model ${MODEL} --yolo --user-input-auto-resolve --workspace "' + $ws + '" --allow-workspace-switch --session-id ' + $sid + ' --prompt-file "' + $base + '\resume-' + $sid + '.txt" < "' + $base + '\empty.txt" > "' + $base + '\resume-' + $sid + '.out" 2>&1'
$c = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "' + $cmd + '"'; CurrentDirectory = $ws }
Start-Sleep 3
$p = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $c.ProcessId) | Where-Object { $_.Name -like 'muse-bin*' } | Select-Object -First 1
if (-not $p) { throw 'muse exec non partito' }
$gp = Get-Process -Id $p.ProcessId
# Il watcher segue il nuovo processo: altrimenti vede la sessione morta e lancia il porting a meta' lavoro.
if ($watch) { @{ pid = $gp.Id; start = $gp.StartTime.ToString('s') } | ConvertTo-Json | Set-Content (Join-Path $watch 'target.json') }
"exec pid $($gp.Id)"`;
}

function defaultPcResume(s, message) {
  return runPowerShell(pcResumeScript(s, message, loadResumeConfig())).trim();
}

function appendLog(line, file = resumeLogFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

// Una ripresa per sessione per finestra di quota (chiave = resetsAt 7d).
// resumeFn(session, message) → descrizione del meccanismo; iniettabile nei test.
export async function run({
  root,
  trayUrl,
  fetchImpl = fetch,
  resumeFn,
  stateFile,
  logFile,
  dryRun = false,
  minIdleMs = MIN_IDLE_MS,
  hosts = ['mac'],
  pcStalled = findStalledPc,
  ownerAlive = (s) => macOwners(s.id).length > 0,
  now = Date.now(),
} = {}) {
  const resumed = [];
  const { free, quota } = await quotaFree(trayUrl, fetchImpl);
  if (!free) return resumed;
  const windowKey = quota.weekResetsAt || quota.fiveHourResetsAt || 'unknown';
  const state = loadResumeState(stateFile);
  const candidates = [];
  if (hosts.includes('mac')) for (const s of findStalled(root)) candidates.push({ ...s, host: 'mac' });
  if (hosts.includes('pc')) {
    try { for (const s of pcStalled()) candidates.push({ ...s, host: 'pc' }); } catch (err) { appendLog(`PC detect failed: ${err.message}`, logFile); }
  }
  for (const s of candidates) {
    if (state[s.id] === windowKey) continue; // già ripresa in questa finestra
    if (Math.max(0, now - s.mtimeMs) < minIdleMs || now - s.mtimeMs > MAX_AGE_MS) continue;
    // Solo sessioni ancora aperte (processo interattivo vivo): le exec finite non si riesumano.
    if (!(s.host === 'pc' ? s.alive : ownerAlive(s))) continue;
    if (dryRun) {
      resumed.push(`${s.host}:${s.id}`);
      continue;
    }
    try {
      const how = (resumeFn || (s.host === 'pc' ? defaultPcResume : defaultMacResume))(s, RESUME_MESSAGE);
      state[s.id] = windowKey;
      appendLog(`RESUMED ${s.host}:${s.id} via ${how} (muse 7d ${quota.weekPct}%, 5h ${quota.fiveHourPct ?? '?'}%)`, logFile);
      resumed.push(`${s.host}:${s.id} via ${how}`);
    } catch (err) {
      appendLog(`FAIL ${s.host}:${s.id}: ${err.message}`, logFile);
    }
  }
  if (!dryRun) saveResumeState(state, stateFile);
  return resumed;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const resumed = await run({
    root: flag('--root'),
    trayUrl: flag('--tray') || 'http://127.0.0.1:3360/api/overview',
    dryRun: args.includes('--dry-run'),
    hosts: (flag('--hosts') || 'mac,pc').split(','),
  });
  for (const r of resumed) console.log(`muse resume: ${r}`);
}
