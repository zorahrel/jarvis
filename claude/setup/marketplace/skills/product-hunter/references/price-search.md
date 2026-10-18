# Price Search & Comparison

## Strategy
1. **Brave Search** for initial product search with price intent
2. **web_fetch** on comparison sites for structured data
3. **Browser** for dynamic sites that need JS rendering

## Italian Price Comparison Sites

### Trovaprezzi.it
- Best for: electronics, appliances, general products
- web_fetch works on product pages
- URL pattern: `https://www.trovaprezzi.it/CATEGORY/prezzi-scheda-prodotto/PRODUCT`

### Idealo.it
- Best for: electronics, fashion, home
- Aggregates from many Italian shops
- URL pattern: `https://www.idealo.it/PRODUCT.html`

### Amazon.it
- Check with Brave Search: `site:amazon.it PRODUCT`
- Keepa.com for price history (needs API key for automation, free for manual check)
- camelcamelcamel.com for Amazon price alerts

### Budget/Chinese Marketplaces (no free API -- use web_search)
- **Shein.it**: ultra-budget fashion. Search: `web_search "PRODUCT site:shein.it"`
- **Temu.com**: ultra-budget everything. Search: `web_search "PRODUCT site:temu.com"`
- **TikTok Shop**: trending products. Search: `web_search "PRODUCT tiktok shop italia"`
- **AliExpress**: budget electronics/accessories. Search: `web_search "PRODUCT site:aliexpress.com"`
- None have free APIs. All require paid scraper services (Oxylabs, Piloterr).
- `web_fetch` works on product pages for structured data extraction.

### Second-Hand / Local
- **Subito.it**: used items, local deals (no API, scrape via web_fetch)
- **Vinted.it**: second-hand fashion
- **eBay.it**: auctions + buy-now

### Italian Retail Chains
- **Unieuro.it, MediaWorld.it**: electronics (check for promos)
- **Decathlon.it**: sport/outdoor -- often in PricesAPI results
- **Footlocker.it**: sneakers -- spesso prezzi migliori del sito ufficiale

## Search Pattern
```
1. Brave Search: "PRODUCT prezzo migliore Italia"
2. Brave Search: "PRODUCT site:trovaprezzi.it OR site:idealo.it"
3. web_fetch top results for structured pricing
4. If needed: browser for JS-heavy sites
5. Compare and present options sorted by price
```

## Product-Specific Tips
- **Shoes/Fashion**: check Amazon, Zalando, brand site, Vinted for used
- **Electronics**: Trovaprezzi > Idealo > Amazon (compare all three)
- **Travel/Transport**: see `references/transport-italy.md`
- **Home/Furniture**: Amazon, IKEA.it, Leroy Merlin, ManoMano
