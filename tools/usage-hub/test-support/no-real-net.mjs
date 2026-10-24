// Preload della sandbox dei test (NODE_OPTIONS=--import): nessuna connessione verso i servizi veri del Mac.
// 3333-3336 sono il proxy VDM e i suoi fratelli, 3360 è l'hub vivo. Un test che ci prova riceve ECONNREFUSED e
// il tentativo finisce in NO_REAL_NET_LOG, così la barra cade anche se il test inghiotte l'errore (giro 9: un
// fetch diretto a 3335 passava, la guardia dell'hub copriva solo la sua rotta /vdm/).
import net from 'node:net';
import fs from 'node:fs';

const PORTS = new Set([3333, 3334, 3335, 3336, 3360]);
const LOG = process.env.NO_REAL_NET_LOG;
const orig = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  const port = Number(o && typeof o === 'object' ? o.port : o);
  const host = String((o && typeof o === 'object' ? o.host : args[1]) || 'localhost');
  // solo il Mac stesso: un servizio esterno su 3335 non è il VDM
  if (PORTS.has(port) && /^(localhost|127\.|::1$|\[::1\]$|0\.0\.0\.0$)/.test(host)) {
    if (LOG) { try { fs.appendFileSync(LOG, `${process.pid} ${host}:${port} ${process.argv.slice(1).join(' ').slice(0, 160)}\n`); } catch {} }
    const err = Object.assign(new Error(`sandbox dei test: connessione a ${host}:${port} rifiutata (servizio vero)`), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return orig.apply(this, args);
};
