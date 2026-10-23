// Conteggi codex/jcode/topics: ogni voce fa da sé, una in errore non ferma le altre.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';

const home = () => os.homedir();

function get(url, { ca, token }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, timeout: 3000, headers: { Authorization: 'Bearer ' + token }, checkServerIdentity: () => undefined }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) return reject(new Error('http ' + r.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

async function defaultTopics() {
  const token = execFileSync('security', ['find-generic-password', '-s', 'topics', '-a', 'agent-token', '-w'], { encoding: 'utf8', timeout: 5000 }).trim();
  const ca = fs.readFileSync(path.join(home(), 'Projects/topics-app/certs/ca-cert.pem'));
  const boards = await get('https://127.0.0.1:3333/api/boards', { ca, token });
  const list = Array.isArray(boards) ? boards : boards.boards || [];
  let total = 0;
  for (const b of list) {
    const cards = await get(`https://127.0.0.1:3333/api/boards/${b.id}/scheduled-cards`, { ca, token });
    total += (Array.isArray(cards) ? cards : cards.cards || cards.scheduled || []).length;
  }
  return total;
}

export async function readCounted({ codexDir, jcodeQueue, topics = defaultTopics } = {}) {
  codexDir ??= path.join(home(), '.codex/automations');
  jcodeQueue ??= path.join(home(), '.jcode/ambient/queue.json');
  let codex = 0;
  try { codex = fs.readdirSync(codexDir).length; } catch { codex = 0; } // cartella assente: zero
  let jcode = 0;
  try {
    const j = JSON.parse(fs.readFileSync(jcodeQueue, 'utf8'));
    const arr = Array.isArray(j) ? j : j.items || j.queue || [];
    jcode = Array.isArray(arr) ? arr.length : 0;
  } catch { jcode = 0; } // coda assente o illeggibile: zero
  let t = null;
  try { t = await topics(); } catch { t = null; } // topics giù: ignoto, non un fallimento
  return { ok: true, at: Date.now(), counts: { codex, jcode, topics: t } };
}
