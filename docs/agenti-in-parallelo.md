# Agenti in parallelo senza pesare sul Mac — studio del 26/10/2026

**Esito.** Il tetto di quanti agenti girano insieme non è la RAM, è la **quota dei modelli**.
La RAM si compra quasi gratis (cloud Claude: VM inclusa; Hetzner CX53 16 vCPU/32 GB a 29,49 €/mese);
la quota no: N agenti in parallelo consumano N volte la finestra di 5 ore. La scelta giusta è
spostare il **calcolo** fuori dal Mac e tenere qui solo l'orchestrazione (Topics, Jarvis).

## Il Mac oggi (misura delle 26/10, pomeriggio)
- 32 GB, pressione memoria **2 (warn)**, swap 6,4 su 7 GB, carico 136 su 12 core.
- Una CLI di agente pesa ~400 MB; il resto lo fanno ciò che lancia: tsserver (2-3 GB), dev server
  node (fino a 2 GB), browser di prova (~1 GB), build. Un agente al lavoro = **1,5-3 GB**.
- Quindi sul Mac, con le app di Attilio accese, stanno ~5-6 agenti attivi prima dello swap.

## 1. Cloud di Claude (sessioni `--cloud`) — fonte: docs ufficiali
- Una VM isolata per sessione (misurata: 4 vCPU, 16 GB, 30 GB disco), **nessun costo per la VM**:
  conta solo la quota del piano. Nessun tetto dichiarato al numero di sessioni insieme; il limite
  è la quota condivisa («più sessioni in parallelo consumano proporzionalmente di più»).
- Già provato da noi l'08/10: T1-T12 di topics-app in parallelo su due account, funziona.
- Limiti: solo GitHub; proxy GitHub senza GraphQL/tag; niente WebKit; niente Keychain, gateway MCP,
  Topics, OpenClaw; VM che si spegne da ferma (si riapre, ma i job in background si perdono);
  timeout dei comandi. Bonus $250 fino al 05/11, poi quota normale (extra usage spento).
- **Self-hosted environments** (le stesse sessioni, ma su macchine nostre): solo piani **Team ed
  Enterprise**, in beta. Noi siamo su Max (`organizationType: claude_max`): oggi non accessibile.
- Uso giusto: lavoro a tracce su repo GitHub (codice + test + PR), verifica sul Mac.

## 2. Cloudflare (Containers / Sandbox SDK) — fonte: pricing e blog GA
- Container per agente, si addormenta da fermo (`sleepAfter`), si sveglia alla prima richiesta.
  Taglie: standard-3 = 2 vCPU/8 GiB, standard-4 = 4 vCPU/12 GiB (massimo). Concorrenza enorme
  (oltre 1.000 istanze grandi insieme).
- Prezzo: CPU solo quando lavora ($0,00002 vCPU-s), memoria e disco sul provisionato
  ($0,0000025 GiB-s). Un agente standard-3 acceso 8 h al giorno per 22 giorni ≈ **18 $/mese**
  (13 memoria + 5 CPU al 20% + 1 disco); dieci agenti ≈ 180 $/mese. Base Workers Paid 5 $/mese.
- Tutorial ufficiale «Run Claude Code on a Sandbox»: lo pensa con una **API key Anthropic**
  (si paga a token). Con l'abbonamento serve `CLAUDE_CODE_OAUTH_TOKEN` da `claude setup-token`:
  stessa quota del piano.
- Contro: è un mattone, non una postazione. Terminale (PTY via WebSocket), anteprime con URL
  pubblico e iniezione di credenziali ci sono, ma il resto lo costruiamo noi: immagine, sessioni,
  ponte con Topics, persistenza (snapshot ancora in arrivo, backup su R2). 12 GiB al massimo per
  container: stretto per suite e2e pesanti.
- Uso giusto: lavori brevi e tanti, lanciati da script (sweep, test, valutazioni), non agenti
  interattivi che Attilio segue in Topics.

## 3. Hetzner (metro di paragone) — prezzi vivi dall'API, Falkenstein, IVA inclusa
| tipo | vCPU | RAM | €/mese |
|---|---|---|---|
| CX53 | 16 condivisi | 32 GB | 29,49 |
| CAX41 (ARM) | 16 condivisi | 32 GB | 40,99 |
| CCX33 | 8 dedicati | 32 GB | 138,49 |
| CCX43 | 16 dedicati | 64 GB | 275,99 |
- Un CX53 regge ~10-15 agenti attivi. Postazione vera: tmux, Topics via ssh (`topics-term` già legge
  tmux), stessi CLI (claude, codex, jcode, muse), segreti da portare fuori dal Keychain.
- Contro: è un server da tenere (aggiornamenti, sicurezza, backup); WebKit macOS resta sul Mac.

## Quanti insieme, davvero
- Calcolo: Mac ~5-6 · un CX53 ~10-15 · cloud Claude e Cloudflare senza tetto pratico.
- Quota (26/10): hi@armonia 64% della finestra di 5 h, guedado esaurito fino al 28/10, zorahrel 16%.
  Con 10 agenti Opus insieme la finestra di un account finisce in meno di un'ora.
- Quindi il moltiplicatore vero è: più account/piani, modelli economici sul meccanico
  (`delegate` → Muse/Codex/gratis), Opus solo su giudizio e verifica.

## Raccomandazione
1. Subito, gratis: il lavoro a tracce va sul **cloud Claude** (VM inclusa), il Mac orchestra e
   verifica. Il bonus scade il 05/11: usarlo ora.
2. Postazione fissa per gli agenti interattivi: **Hetzner CX53** (29,49 €/mese), con Topics sul Mac
   come schermo. Rende di più per euro di qualunque altra opzione.
3. Cloudflare solo se nasce un bisogno di lavori brevi e tanti da script: oggi non c'è.
4. Se Armonia passa a **Team**, i self-hosted environments uniscono 1 e 2: sessioni cloud con la UI
   di Claude, ma sul nostro Hetzner.

Fonti: code.claude.com/docs/en/claude-code-on-the-web · code.claude.com/docs/en/self-hosted-environments ·
developers.cloudflare.com/containers/pricing · blog.cloudflare.com/sandbox-ga ·
developers.cloudflare.com/sandbox/tutorials/claude-code · api.hetzner.cloud/v1/pricing (26/10).
