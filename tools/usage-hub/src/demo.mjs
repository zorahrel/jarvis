// Log finti generati al volo (timestamp freschi): servono a --demo e ai test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS = [
  ['billing-api', 400, 800], ['mobile-app', 250, 600], ['docs-site', 80, 300], ['infra', 30, 200],
];

export function makeDemoRoot(now = Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hub-demo-'));
  for (const [name, n, out] of PROJECTS) {
    const dir = path.join(root, `-work-${name}`);
    fs.mkdirSync(dir);
    const lines = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({
        timestamp: new Date(now - 3600000 - i * 1000).toISOString(),
        cwd: `/work/${name}`,
        message: { id: `m${i}`, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000 } },
      }));
    }
    fs.writeFileSync(path.join(dir, 's.jsonl'), lines.join('\n') + '\n');
  }
  return root;
}

// `usage-hub --demo` vive finché lo ferma qualcuno: la cartella dei log finti va tolta quando esce
// (ne restavano 1.100 in $TMPDIR). I segnali passano da process.exit perché il default non fa girare 'exit'.
export function removeOnExit(root) {
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(0));
  return root;
}
