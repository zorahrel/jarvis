import '../test-support/isolate-tmp.mjs';
// Una fonte che cade (carico alto, cache vuota dopo un riavvio) non svuota le sue voci: vale l'ultima buona letta su disco.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createAutomations } = await import('../src/automations/index.mjs');

const NOW = 1792764000000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cadute-'));
const agents = path.join(dir, 'LaunchAgents');
fs.mkdirSync(agents);
fs.writeFileSync(path.join(agents, 'com.jarvis.prova.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.jarvis.prova</string>
<key>ProgramArguments</key><array><string>/bin/echo</string><string>ciao</string></array>
<key>StartInterval</key><integer>3600</integer>
</dict></plist>`);

const item = (key, provider) => ({ key, provider, name: key, enabled: true, everyMs: 86400000, when: 'ogni giorno',
  next: NOW + 3600000, nextApprox: false, expectedLast: null, last: { at: NOW - 3600000, outcome: 'ok', delivered: 'none', error: null },
  runs: [{ at: NOW - 3600000, outcome: 'ok' }], consecutiveErrors: 0, runsToday: 1, who: 'script', reportsTo: 'nessun messaggio',
  tech: { schedule: null, exit: 0, command: 'x', prompt: null, label: key, url: null } });
const ghWarm = { read: () => ({ ok: true, pending: false, at: NOW, items: [item('gh:armonia/tdh/security.yml', 'github')] }), refresh: async () => {} };
const pcWarm = { read: () => ({ ok: true, asleep: false, at: NOW, items: [item('pc:attivita-serale', 'pc')] }), refresh: async () => {} };
const ghCold = { read: () => ({ ok: false, pending: true, at: null, items: [] }), refresh: async () => {} };
const pcCold = { read: () => ({ ok: false, pending: true, items: [] }), refresh: async () => {} };

// Un processo nuovo con le fonti calde o fredde: launchctl fredda = non risponde, come sotto carico.
function servizio({ calde, file, now = NOW }) {
  return createAutomations({
    now: () => now, background: false, lastGoodFile: file, agentsDir: agents, feedbackDir: path.join(dir, 'fb'),
    launchctlList: calde ? async () => '123\t0\tcom.jarvis.prova\n' : async () => { throw new Error('launchctl non risponde'); },
    launchctlRuns: async () => null, readDescriptions: () => ({}), readHealth: () => { throw new Error('nessuno'); },
    openclaw: () => ({ ok: true, at: now, items: [] }), desktop: () => ({ ok: true, at: now, items: [] }),
    workflows: () => ({ ok: true, at: now, items: [], runs: [] }), counted: async () => ({ ok: true, at: now, counts: {} }),
    github: calde ? ghWarm : ghCold, pc: calde ? pcWarm : pcCold,
  });
}
const vociDelleFonti = (m) => Object.keys(m.cards).filter((k) => /^(launchd|gh|pc):/.test(k)).sort();

test('una fonte che cade dopo un riavvio non svuota le sue voci: vale l\'ultima buona su disco', async () => {
  const file = path.join(dir, 'ultima-buona.json');
  const prima = await servizio({ calde: true, file }).model({ fresh: true });
  const dopo = await servizio({ calde: false, file }).model({ fresh: true });
  assert.deepEqual(vociDelleFonti(prima), ['gh:armonia/tdh/security.yml', 'launchd:com.jarvis.prova', 'pc:attivita-serale']);
  assert.deepEqual(vociDelleFonti(dopo), vociDelleFonti(prima), 'nessuna voce delle fonti cadute sparisce');
  const fonte = dopo.footer.sources.find((s) => s.name === 'launchd');
  assert.equal(fonte.ok, false, 'il footer dice che la fonte adesso non risponde');
});

test('senza copia su disco la stessa caduta svuota le voci: il caso che il test difende è reale', async () => {
  const dopo = await servizio({ calde: false, file: path.join(dir, 'non-esiste.json') }).model({ fresh: true });
  assert.deepEqual(vociDelleFonti(dopo), []);
});

test('una copia più vecchia di 24 ore non si riusa', async () => {
  const file = path.join(dir, 'vecchia.json');
  await servizio({ calde: true, file }).model({ fresh: true });
  const dopo = await servizio({ calde: false, file, now: NOW + 25 * 3600000 }).model({ fresh: true });
  assert.deepEqual(vociDelleFonti(dopo), []);
});
