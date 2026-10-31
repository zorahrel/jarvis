# e2e sul PC: browser remoto via pw-remote

## Perche'

Il 24/10 gli e2e della landing di un cliente giravano sul Mac con `OFFLOAD=local`: carico 164 su 12 core.
Il browser Chromium e' la fonte principale di CPU durante un giro Playwright; runner e vite restano leggeri.

## Soluzione

I browser girano sul PC tramite un `run-server` Playwright raggiunto con un tunnel ssh.
Runner e vite restano sul Mac: l'unica cosa che cambia per i test e' la variabile d'ambiente
`PW_TEST_CONNECT_WS_ENDPOINT` che Playwright usa per delegare al browser remoto.

```
Mac: playwright runner + vite dev server
  |
  | ssh -L 127.0.0.1:LPORT:127.0.0.1:RPORT
  v
PC: playwright run-server + Chromium
    (E:\offload\pw-srv\<versione esatta, es. 1.47.0>\)
```

Il `run-server` sul PC ascolta solo sul loopback (127.0.0.1): uno shim Node.js sovrascrive
`net.Server.prototype.listen` prima dell'avvio del server.

`exposeNetwork` e' limitato alle sole porte del test server (estratte da `baseURL` nel config
Playwright o da `PW_EXPOSE_PORTS`): mai `<loopback>`, che aprirebbe l'intero loopback Mac
al browser del PC (gateway, db, inspector).

## Strumenti

- **`~/bin/pw-remote -- <comando>`**: avvia il tunnel, verifica che il server risponda,
  imposta le variabili d'ambiente e lancia il comando. `pw-remote -h` per l'uso completo.
  Exit: quello del comando; 64 = nessun @playwright/test, storageState senza PW_REMOTE_ALLOW_AUTH,
  o nessuna porta da esporre; 75 = PC non risponde in 60 s; 76 = run-server non parte.

- **`PW_REMOTE_ALLOW_AUTH=1`**: necessario se il config ha `storageState` (sessioni autenticate).
  Di default pw-remote rifiuta per non mandare cookie al browser del PC.

- **`PW_WATCHDOG_MINUTES=N`** (default: 2): il run-server sul PC viene chiuso automaticamente
  se il client scompare per piu' di N minuti (crash del Mac, SSH caduto, ecc.).

- **Shim offload-shims** (`~/.openclaw/bin/offload-shims/_shim`): a Mac carico (> 1.5 per core),
  i comandi `npx playwright test`, `bun run e2e`, ecc. sono automaticamente instradati a `pw-remote`.
  I test non-Playwright (vitest, jest, bun test) vanno a `offload` sul PC via la normale suite.

- **Hook offload-guard** (`~/.claude/hooks/offload-guard.sh`): su Claude Code, Codex, Muse e jcode,
  se l'agente scrive un comando Playwright a Mac carico, l'hook lo suggerisce di riscrivere con `pw-remote`.

## Misura (26/10)

CPU·s = tempo CPU reale (user+sys, rusage di `/usr/bin/time -l`) dell'albero di processi sul Mac:
runner + ssh + server (dev o preview), tutto dentro il comando misurato. Script: `measure-cpu.sh [N] [fixture|<progetto>]`
(`MC_SERVER=preview` per la build di produzione), 3 giri per lato, un giro non verde invalida la misura.
Landing di un cliente (il progetto sta nello script, che e' privato), spec components + mobile-nav (10 test), Mac a ~0,9 di carico per core:

| Server | Locale | Remoto | Remoto/locale | Giri remoti verdi |
|--------|--------|--------|---------------|-------------------|
| vite preview (build di produzione) | 15.55 CPU·s, 15 s | 10.14 CPU·s, 119 s | 65% | 3 su 3 |
| vite dev | 25.0 CPU·s, 16 s | 22.4 CPU·s, 264 s | 90% | 0 su 3 (goto oltre i 30 s) |

Output completo dei giri nella card del 26/10. Con il dev server il browser remoto carica centinaia di moduli
uno a uno dentro il tunnel: ogni pagina impiega decine di secondi e i test scadono. Con la build il carico e' un
pacchetto solo e il giro passa, ma il Mac paga ancora runner, ssh e il proxy delle richieste.

**Barra riscritta:** non e' piu' «remoto ≤ 40% del locale» (non raggiungibile: 65% nel caso migliore, perche' in questi
test il browser pesa poco e il costo fisso del runner resta sul Mac). Vale: giro remoto verde 3 su 3 e remoto < 70% del
locale su build di produzione. pw-remote serve a togliere i browser dal Mac saturo, non a dimezzare i CPU·s totali,
e va usato con la build, non col dev server. Misure precedenti (carico del Mac 22-31): dev server 59%, 45% con 18 test
di layout (6 rossi in remoto).

Limite di fedelta': i test che misurano layout (overflow orizzontale, geometria) falliscono sul Chromium del PC
(font diversi): in remoto vanno bene i test funzionali, non quelli sui pixel.

## Barra

```
sh ~/.claude/setup/shared/pw-remote-test.sh                # verde 9 controlli + 9 mutanti rossi (M1-M9)
sh ~/.claude/setup/shared/offload-shims-test.sh            # verde 8 casi
MC_SERVER=preview sh ~/.claude/setup/shared/measure-cpu.sh 3 <progetto>    # misura CPU·s, 3 giri per lato (anche: fixture)
```

Prerequisito: PC accessibile via SSH (HOST_SSH da `~/.config/winfleet/config.env`; `winwake` se spento).
Il PC si sveglia da solo se e' spento: `pw-remote` chiama `winwake` e aspetta 60 s.

## Versioni e primo avvio

Playwright viene installato sul PC nella cartella `E:\offload\pw-srv\<versione-esatta>\`
(una cartella per ogni versione, es. `1.47.0`). Se la versione cambia, la prima esecuzione di
`pw-remote` installa automaticamente la nuova versione e scarica Chromium sul PC (pochi minuti,
poi resta in cache). Runner Mac e server PC devono essere alla stessa versione esatta: ogni
minor di Playwright cambia il protocollo WebSocket.

## Rifiuti e controlli di sicurezza

- `storageState` nella config (anche passata con `-c`/`--config`, in qualsiasi formato `.ts .js .mjs .mts .cjs .cts`) o negli spec: exit 64 prima di toccare il PC. `PW_REMOTE_ALLOW_AUTH` apre solo con valore esattamente `1`.
- Lo spec `expose-network.spec.ts` prova una porta vietata con `goto` e con `fetch` no-cors, su `localhost` e `127.0.0.1`: se una raggiunge il Mac, il controllo 7 della barra e' rosso.
