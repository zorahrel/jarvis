// «Connection refused - a firewall or proxy may be blocking it» non e' un
// firewall: e' il proxy che ascolta su 127.0.0.1 mentre il client ha scritto
// "localhost", e Node risolve localhost verbatim - su macOS ::1 viene prima.
//
// Questo non e' un caso di scuola: e' successo, e la diagnosi e' costata tempo
// proprio perche' il messaggio manda a cercare una cosa che non c'e'. Un test
// che legge il sorgente non basterebbe da solo, ma il comportamento vero
// richiederebbe di avviare tutto il dashboard: si prova quindi il MECCANISMO
// (un secondo server che rigira l'evento request al primo) su una porta di
// prova, piu' la presenza del listener nel sorgente.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import dns from 'node:dns';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'dashboard.mjs'), 'utf8').replace(/\r\n/g, '\n');

test('the proxy also listens on the IPv6 loopback', () => {
  const i = src.indexOf("proxyServer6.listen(PROXY_PORT, '::1'");
  assert.ok(i > 0, 'no ::1 listener: clients using "localhost" will get ECONNREFUSED');

  // Deve riusare LO STESSO handler, non essere una seconda implementazione che
  // col tempo diverge da quella vera.
  assert.match(src, /proxyServer6 = createServer\(\(clientReq, clientRes\) => \{\s*proxyServer\.emit\('request', clientReq, clientRes\);/);

  // Un bind che fallisce (IPv6 spento, porta occupata) non deve uccidere il
  // processo: senza IPv4 non risponde piu' nessuno, e si spegnerebbero tutte le
  // sessioni per un di piu'.
  assert.match(src, /proxyServer6\.on\('error'/);

  // E resta loopback: '::' o '0.0.0.0' offrirebbero i token Anthropic a
  // chiunque sia sulla stessa rete.
  assert.doesNotMatch(src.slice(i, i + 200), /'::'|0\.0\.0\.0/);
});

test('a second listener on ::1 serves the same handler as the IPv4 one', async () => {
  const PORT = 39337;
  const seen = [];
  const srv4 = createServer((req, res) => {
    seen.push(req.socket.remoteFamily);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const srv6 = createServer((req, res) => { srv4.emit('request', req, res); });

  await new Promise((r) => srv4.listen(PORT, '127.0.0.1', r));
  let ipv6up = true;
  await new Promise((r) => {
    srv6.once('error', () => { ipv6up = false; r(); });
    srv6.listen(PORT, '::1', r);
  });

  try {
    if (!ipv6up) {
      // Su una macchina senza IPv6 il difetto non puo' presentarsi: localhost
      // risolve solo a 127.0.0.1. Dirlo e' meglio che fingere di aver provato.
      assert.ok(true, 'IPv6 unavailable on this machine: nothing to prove');
      return;
    }
    for (const url of [`http://127.0.0.1:${PORT}/`, `http://[::1]:${PORT}/`, `http://localhost:${PORT}/`]) {
      const r = await fetch(url);
      assert.equal(r.status, 200, `${url} should be served`);
    }
    // La prova che il difetto era reale: localhost ha davvero preso la strada
    // IPv6, quindi senza quel listener sarebbe stato ECONNREFUSED.
    const order = dns.getDefaultResultOrder();
    if (order === 'verbatim' && seen.includes('IPv6')) {
      assert.ok(seen.filter((f) => f === 'IPv6').length >= 2, 'localhost resolved to ::1, as in the incident');
    }
  } finally {
    srv4.close();
    srv6.close();
  }
});
