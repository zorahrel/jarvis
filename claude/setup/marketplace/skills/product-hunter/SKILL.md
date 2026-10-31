---
name: product-hunter
description: Find best prices and deals for products, transport, and services. Use when the user asks to buy something, compare prices, find cheapest options, search for deals, book transport (trains, buses, flights), or research products before purchasing. Covers Italian and international e-commerce (Amazon, Trovaprezzi, Idealo, Subito, Vinted, Shein) and transport (FlixBus API, Trenitalia, Italo, Itabus).
---

# Product Hunter

Find the best price for anything — products, transport, services.

## Workflow

1. Identify what the user wants to buy/find
2. Choose the right search strategy (see below)
3. Search multiple sources, compare
4. Present options sorted by value (price + quality + convenience)

## Transport Search

For transport/travel requests, read `references/transport-italy.md`.

**FlixBus** (only free transport API):
```bash
python3 scripts/flixbus-search.py "Salerno" "Fiumicino" "06.03.2026" 1
```
Airport names auto-resolve: "Fiumicino" -> "Aeroporto di Roma Fiumicino (FCO)".

For trains: use browser on lefrecce.it or italotreno.it (no free API exists).
For aggregated bus results: web_fetch CheckMyBus.it.

## Product Price Search

For product purchases, read `references/price-search.md`.

### 1. `shop` — fonte primaria (CLI in `~/bin`, nessuna quota)
Copre in un colpo solo Amazon, Google Shopping, Trovaprezzi, Zalando, eBay, Vinted,
Subito, AliExpress. E' lo strumento che regge tutto il resto.
```bash
shop compare-prices --query "<prodotto>" --limit 20            # tutte le fonti nuove
shop compare-prices --query "<prodotto>" --include-used         # + eBay/Vinted/Subito
shop amazon-product --asin B0XXXXXXXX                           # prezzo, stock, recensioni, varianti
shop search-ebay --query "..."   # anche: search-amazon, search-trovaprezzi,
                                 # search-google-shopping, search-zalando, search-vinted
shop read-shop-page --url "<url>"                               # scheda di un negozio qualsiasi
```
Trappole misurate:
- Il prezzo piu' basso e' **quasi sempre una variante diversa** (taglia, quantita', colore).
  Conferma sempre con `amazon-product --asin` prima di citarlo.
- Le righe AliExpress tornano come **pagine di ricerca**, non prodotti: i loro prezzi
  non sono preventivi e non si riportano come tali.

### 2. `prices-search.py` — negozi specializzati che `shop` non vede
1.000 chiamate/mese. Una sola chiamata per query: le offerte arrivano gia' inline.
```bash
python3 scripts/prices-search.py "<prodotto>" it
```
Da' seller, prezzo, **stock_status** e spedizione di negozi di nicchia (pet shop,
elettromedicali, ricambi) dove Amazon non arriva. La chiave sta nel Keychain
(`security find-generic-password -s pricesapi -a api -w`) e viene caricata da sola.

### 3. Fonti senza API
Shein, Temu, TikTok Shop non hanno API gratuite e `web_search` qui e' **disabilitato**:
se servono, si aprono a mano nel browser. Non promettere un confronto che non puoi fare.

### Cosa NON funziona su questo Mac (verificato 22/09/2026)
- `scripts/amazon-search.py` — `scrapling` non e' installato. Usa `shop search-amazon`.
- `web_search` / `web_fetch` come ripiego prezzi — provider disabilitato.

## API Budget (monthly)
- **PricesAPI.io**: 1.000 chiamate, 1 per ricerca
- **shop**: nessuna quota, ma throttling dopo ~12 ricerche ravvicinate
- **FlixBus**: unlimited

## Key Rules
- **SEMPRE verificare disponibilita** prima di mandare un link: `shop amazon-product --asin`
  per Amazon, `stock_status` di `prices-search.py` altrove. Mai un link non verificato.
- Se non riesci a verificare, scrivilo esplicitamente: "!! Disponibilita non verificata"
- **Guarda le recensioni, non solo il prezzo.** "4,8" su 3 recensioni non e' un giudizio:
  riporta sempre rating **e** numero, e diffida sotto le ~30.
- **La forma batte il prezzo.** Prima di consigliare il pacco piu' economico, verifica che
  sia lo stesso oggetto: misure, materiale, uso. Un bicchierino da shot costa meta' di una
  coppetta per rettili e non funziona, perche' e' alto e stretto.
- Per Temu/AliExpress: i prodotti cambiano spesso -- verifica che il link funzioni prima di mandarlo
- Always check at least 2-3 sources before recommending
- For Italian market: Trovaprezzi + Idealo + Amazon.it as baseline
- For transport: FlixBus API first (free + reliable), then browser for trains
- Note seasonal services (e.g., Leonettibus only summer)
- Flag tourist traps (e.g., Leonardo Express vs bus navetta)
- Include used/refurbished options when relevant (Subito, Vinted, eBay)
- Per l'ultra-budget: `shop compare-prices --include-used` copre eBay/Vinted/Subito/AliExpress.
  Shein, Temu e TikTok Shop restano fuori portata: dillo invece di fingere di averli guardati.
