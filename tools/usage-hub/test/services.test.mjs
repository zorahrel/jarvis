import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchctl, parseListen, describe, timers, family } from '../src/services.mjs';
import { parseFootprint } from '../src/mac.mjs';

const lc = 'PID\tStatus\tLabel\n100\t0\tcom.jarvis.usage-hub\n-\t0\tcom.jarvis.free-router\n-\t78\tcom.jarvis.vdm\n-\t1\tcom.jarvis.backup\n-\t0\tcom.jarvis.repo-ff\n200\t0\tcom.apple.x\n';
const ls = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 100 z 14u IPv4 0x1 0t0 TCP 127.0.0.1:3360 (LISTEN)\n';
const fp = 'node [100]: 64-bit    Footprint: 70 MB (16384 bytes per page)\nbun [101]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)\nx [300]: 64-bit    Footprint: 512 KB\n';
const procs = [{ pid: 100, ppid: 1, cmd: 'node hub' }, { pid: 101, ppid: 100, cmd: 'bun child' }, { pid: 300, ppid: 1, cmd: 'node /x/topics-board/server.mjs' }];
const services = [
  { id: 'hub', label: 'com.jarvis.usage-hub', port: 3360 },
  { id: 'free', label: 'com.jarvis.free-router', onDemand: true },
  { id: 'vdm', label: 'com.jarvis.vdm', port: 3335 },
  { id: 'board', match: 'topics-board/server.mjs', port: 4000 },
  { id: 'gone', label: 'com.jarvis.gone' },
];

test('servizi: vivo, in attesa, fermo con codice, vivo che non ascolta, spento; memoria propria e con i figli', () => {
  const jobs = parseLaunchctl(lc);
  const out = describe(services, { jobs, procs, ports: parseListen(ls), mem: parseFootprint(fp) });
  const by = Object.fromEntries(out.map((x) => [x.id, x]));
  assert.equal(by.hub.state, 'vivo'); assert.equal(by.hub.mb, 70); assert.equal(by.hub.treeMb, 70 + 1536); assert.equal(by.hub.children, 1);
  assert.equal(by.free.state, 'in attesa'); assert.equal(by.free.problem, null);
  assert.equal(by.vdm.state, 'fermo'); assert.equal(by.vdm.problem, 'uscito con codice 78');
  assert.equal(by.board.state, 'vivo'); assert.equal(by.board.problem, 'non ascolta su :4000'); assert.equal(by.board.mb, 1);
  assert.equal(by.gone.state, 'spento');
  // a orario: solo le label di casa non elencate e senza processo, prima quelle uscite con errore
  assert.deepEqual(timers(services, jobs).map((t) => t.label), ['com.jarvis.backup', 'com.jarvis.repo-ff']);
});

test('family: figli e nipoti, senza giri', () => {
  assert.deepEqual(family(1, [{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 9 }]), [1, 2, 3]);
});
