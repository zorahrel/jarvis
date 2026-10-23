// Primo import di ogni file di test che scrive su disco: da qui in poi $TMPDIR è una cartella
// solo sua, tolta all'uscita. Senza, ogni mkdtemp dei test restava in $TMPDIR per sempre
// (106 mila voci, 15 GB al 23/10). I figli lanciati dai test la ereditano dall'ambiente.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
process.env.TMPDIR = dir + '/'; // con la barra finale, come la dà macOS: qualcuno concatena senza path.join
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* già tolta */ }
});
