// Primo import di ogni file di test che scrive su disco: da qui in poi $TMPDIR è una cartella
// solo sua, tolta all'uscita. Senza, ogni mkdtemp dei test restava in $TMPDIR per sempre
// (106 mila voci, 15 GB al 23/10). I figli lanciati dai test la ereditano dall'ambiente.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
process.env.TMPDIR = dir + '/'; // con la barra finale, come la dà macOS: qualcuno concatena senza path.join
// La copia delle fonti (ultima lettura buona) sta in cache sotto HOME: i test non devono leggere né riscrivere quella vera.
process.env.USAGE_HUB_LAST_GOOD = path.join(dir, 'automazioni-ultima-buona.json');
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* già tolta */ }
});
