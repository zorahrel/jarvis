// Raccoglie i campioni di memoria che il gateway OpenClaw registra da solo ogni 30 s (heap principale per spazio
// e heap di ogni worker) più i turni di conversazione, dal buffer di diagnostics.stability (23/10, 6 h e mezza).
// Il buffer tiene 1000 eventi, cioè ~5 min sotto carico: si legge ogni 2 min e si tiene solo ciò che è nuovo.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.join(os.homedir(), '.cache', 'oc-heapwatch', 'cont', 'stability.jsonl');
const keep = new Set(['diagnostic.memory.sample', 'session.turn.created', 'message.processed', 'model.call.completed']);
const end = Date.now() + 43200e3;
let last = 0;
const mb = (n) => Math.round(n / 1e6);
while (Date.now() < end) {
  try {
    const snap = JSON.parse(execFileSync('/opt/homebrew/bin/openclaw', ['gateway', 'call', 'diagnostics.stability', '--json', '--params', '{}'], { encoding: 'utf8', timeout: 60e3, maxBuffer: 64e6 }));
    // il seq riparte da 1 quando il gateway si riavvia: senza questo, dopo un riavvio nessun evento passa il filtro
    if (snap.lastSeq < last) last = 0;
    const lines = [];
    if (last && snap.firstSeq > last + 1) lines.push({ ts: Date.now(), type: 'gap', from: last, to: snap.firstSeq });
    for (const e of snap.events) {
      if (e.seq <= last || !keep.has(e.type)) continue;
      if (e.type !== 'diagnostic.memory.sample') { lines.push({ seq: e.seq, ts: e.ts, type: e.type }); continue; }
      const m = e.memory;
      const space = Object.fromEntries((m.heapSpaces || []).map((s) => [s.space_name, mb(s.space_used_size)]));
      lines.push({
        seq: e.seq, ts: e.ts, type: 'mem', rss: mb(m.rssBytes), heapUsed: mb(m.heapUsedBytes), old: space.old_space, code: space.code_space,
        lo: space.large_object_space, workers: m.workerCount, workerHeapUsed: mb(m.workerHeapUsedBytes || 0),
        workerHeaps: (m.workerHeaps || []).map((w) => [w.script, mb(w.heapUsed)]),
      });
    }
    last = Math.max(last, snap.lastSeq);
    if (lines.length) fs.appendFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  } catch (err) {
    fs.appendFileSync(out, JSON.stringify({ ts: Date.now(), type: 'error', message: String(err.message).slice(0, 200) }) + '\n');
  }
  await new Promise((r) => setTimeout(r, 120e3));
}
fs.renameSync(path.join(os.homedir(), 'Library/LaunchAgents/com.jarvis.oc-stabwatch.plist'), path.join(os.homedir(), 'Library/LaunchAgents/disabled/com.jarvis.oc-stabwatch.plist'));
execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/com.jarvis.oc-stabwatch`]);
