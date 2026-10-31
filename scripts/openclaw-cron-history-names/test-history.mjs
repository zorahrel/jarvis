// Riproduce il guasto di chat.history del 26/10 sul modulo vero di OpenClaw (dist indicato da OC_DIST).
// Una sessione con un legame claude-cli ma provider diverso (Jarvis su Discord) contiene un messaggio
// iniettato da un cron (provenance internal_system, sourceTool cron, jobId): la lettura di idoneita'
// della storia CLI proietta la coda senza risolutore dei nomi dei cron e il core lancia
// «Cron job names must be prepared before projecting forwarded messages».
// Exit 0 = la lettura passa · 1 = quell'errore · 2 = qualunque altro errore (test da rivedere).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = process.env.OC_DIST;
const file = readdirSync(dist).filter((f) => /^cli-session-history-[\w-]+\.mjs$/.test(f));
if (file.length !== 1) { console.error(`attesi 1 modulo cli-session-history, trovati ${file.length}`); process.exit(2); }
const { prepareCliSessionHistoryReader } = await import(pathToFileURL(join(dist, file[0])).href);

// stessa forma del messaggio vero (seq 774, cron «Certificato https di esempio.it»)
const cron = {
  role: 'user',
  content: '[cron:job-cli Certificato] Controlla il certificato.',
  timestamp: Date.now(),
  provenance: {
    kind: 'internal_system',
    sourceSessionKey: 'agent:main:cron:job-cli:run:r1',
    sourceTool: 'cron',
    sourcePromptPrefix: '[cron:job-cli Certificato]',
    jobId: 'job-cli',
    runId: 'r1',
  },
  __openclaw: { seq: 1 },
};
const readers = {
  readHistoryRevision: async () => 0,
  readRecentSessionMessagesWithStatsAsync: async () => ({ messages: [cron], totalMessages: 1, totalBytes: 200 }),
  readSessionMessagesPageWithStatsAsync: async () => ({ messages: [cron], totalMessages: 1, totalBytes: 200 }),
};
try {
  await prepareCliSessionHistoryReader({
    entry: { cliSessionBindings: { 'claude-cli': { sessionId: 'cli-1' } } },
    sessionId: 's1',
    storePath: '/nonexistent/sessions.json',
    sessionAgentId: 'main',
    canonicalKey: 'agent:main:discord:channel:1',
    provider: 'openai-codex',
    effectiveMaxChars: 4000,
    max: 50,
    maxHistoryBytes: 1_000_000,
    offset: 0,
  }, readers);
  console.log('ok: lettura di idoneita\' passata');
  process.exit(0);
} catch (e) {
  const msg = String(e?.message ?? e);
  console.error(msg);
  process.exit(/Cron job names must be prepared/.test(msg) ? 1 : 2);
}
