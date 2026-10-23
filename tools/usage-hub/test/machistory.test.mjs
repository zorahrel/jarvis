import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macHistory } from '../src/macwatch.mjs';

test('storico del Mac: al massimo 120 punti, ogni fetta tiene il picco', () => {
  const ring = Array.from({ length: 1440 }, (_, i) => ({ t: i * 60, cpu: i === 700 ? 99 : 10, mem: 50, gpu: null, disk: 80 }));
  const h = macHistory(ring);
  assert.equal(h.cpu.length, 120);
  assert.equal(Math.max(...h.cpu.map((p) => p.v)), 99);
  assert.deepEqual(h.gpu, []);
});

test('RAM come Activity Monitor: la cache dei file non è usata, app = usata − wired − compressa', async () => {
  const { memBreakdown } = await import('../src/mac.mjs');
  const page = 2 ** 20; // 1 MiB a pagina: 1024 pagine = 1 GB
  const m = memBreakdown({ pageSize: page, activePages: 4096, inactivePages: 2048, speculativePages: 0, wiredPages: 2048, compressorPages: 1024, purgeablePages: 512, filePages: 1536 }, 16 * 2 ** 30);
  assert.deepEqual([m.usedGB, m.appGB, m.wiredGB, m.compressedGB, m.cachedGB, m.freeGB], [7, 4, 2, 1, 2, 7]);
  assert.equal(memBreakdown({ pageSize: page }), null, 'senza vm_stat completo niente numeri inventati');
});
